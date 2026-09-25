import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, resolveConfig, type EventEnvelope } from '@gtbd/protocol';
import { Experiment, SessionRecorder } from '@gtbd/core';
import { startHost, type RunningHost } from '../src';

const hosts: RunningHost[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const h of hosts.splice(0)) await h.close();
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gtbd-host-'));
const quiet = () => {};

/** A JSON WebSocket client that records every message, with a helper to wait for one. */
async function client(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const got: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    got.push(m);
    for (const w of [...waiters]) if (w.pred(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return {
    ws,
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    waitFor: (pred: (m: any) => boolean, ms = 3000) =>
      new Promise<any>((resolve, reject) => {
        const hit = got.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
        waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      }),
  };
}

/** Run a short real experiment and return its envelopes. */
function generateEvents(sessionId: string): EventEnvelope[] {
  const exp = new Experiment({ config: resolveConfig({ calibration: { enabled: false }, numBlocks: 1, numTrials: 4 }), participantId: 'P9', seed: 5, version: 'test' });
  const rec = new SessionRecorder(sessionId, () => 1_700_000_000_000);
  const out: EventEnvelope[] = [];
  exp.on((e) => out.push(rec.record(e)));
  exp.start();
  for (let t = 0; t < 60_000 && exp.status().phase !== 'ended'; t++) {
    if (exp.status().screen?.interactive) exp.dispatch({ type: 'continue', source: 'participant' });
    exp.advance(1);
  }
  return out;
}

async function setup() {
  const pDir = tmp();
  const aDir = tmp();
  const p = await startHost({ role: 'participant', dataDir: pDir, port: 0, bindAddress: '127.0.0.1', log: quiet });
  const a = await startHost({ role: 'admin', dataDir: aDir, port: 0, log: quiet });
  hosts.push(p, a);
  const game = await client(`ws://127.0.0.1:${p.port}/ui`);
  const hello = await game.waitFor((m) => m.t === 'hello');
  const adminUi = await client(`ws://127.0.0.1:${a.port}/ui`);
  await adminUi.waitFor((m) => m.t === 'hello');
  return { p, a, pDir, aDir, game, adminUi, code: hello.pairingCode as string, address: `127.0.0.1:${p.port}` };
}

const waitUntil = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('participant + admin hosts over a real LAN socket', () => {
  it('pair, capture, mirror byte-for-byte, relay admin commands, sync clocks', async () => {
    const { p, a, game, adminUi, code, address } = await setup();
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{2,4}){6}$/);

    adminUi.send({ t: 'connect', address, pairingCode: code });
    await adminUi.waitFor((m) => m.t === 'peer' && m.peer.state === 'connected');
    await game.waitFor((m) => m.t === 'admin-link' && m.status === 'connected');
    await game.waitFor((m) => m.t === 'pairing' && m.code === null); // the code is used up

    const sessionId = 'sess-1';
    game.send({ t: 'session.open', sessionId, participantId: 'P9', version: 'test', startedAt: new Date().toISOString(), config: DEFAULT_CONFIG });
    const opened = await game.waitFor((m) => m.t === 'session.opened');
    const events = generateEvents(sessionId);
    const half = Math.floor(events.length / 2);
    game.send({ t: 'events', sessionId, events: events.slice(0, half) });
    game.send({ t: 'events', sessionId, events: events.slice(half - 3) }); // overlapping resend
    const last = events.at(-1)!.seq;
    await game.waitFor((m) => m.t === 'ack' && m.seq === last);
    await adminUi.waitFor((m) => m.t === 'mirror' && m.mirror.lastSeq === last);

    const mirrorDir = adminUi.got.filter((m) => m.t === 'mirror').at(-1).mirror.dir;
    for (const f of ['events.jsonl', 'event_log.txt']) {
      expect(fs.readFileSync(path.join(mirrorDir, f), 'utf8')).toBe(fs.readFileSync(path.join(opened.logDir, f), 'utf8'));
    }
    const legacy = fs.readFileSync(path.join(opened.logDir, 'event_log.txt'), 'utf8');
    expect(legacy).toMatch(/BLOCK_RESULTS,0,\d+,\d+,4\r\n/);
    expect(legacy.trimEnd().endsWith('EXPERIMENT_END')).toBe(true);

    adminUi.send({ t: 'cmd', command: 'block-start' });
    await game.waitFor((m) => m.t === 'cmd' && m.command === 'block-start');

    const clock = await game.waitFor((m) => m.t === 'clock-sync');
    // Same machine, so the true offset is 0. The estimate t1 - (t0 + t2) / 2 is off by at most
    // half the round trip (t1 lies between t0 and t2), plus 1 ms for millisecond clocks. A
    // fixed limit fails under load, when the first ping's round trip stretches past 100 ms.
    expect(Math.abs(clock.offsetMs)).toBeLessThanOrEqual(clock.rttMs / 2 + 1);
    expect(a.admin!.peerSummary.clock).not.toBeNull();
    expect(p.participant!.pairingCode).toBeNull();
  });

  it('a mirror catches up after reconnecting with the stored code', async () => {
    const { game, adminUi, code, address } = await setup();
    adminUi.send({ t: 'connect', address, pairingCode: code });
    await adminUi.waitFor((m) => m.t === 'peer' && m.peer.state === 'connected');
    const sessionId = 'sess-2';
    game.send({ t: 'session.open', sessionId, participantId: 'P9', version: 'test', startedAt: new Date().toISOString(), config: DEFAULT_CONFIG });
    await game.waitFor((m) => m.t === 'session.opened');
    const events = generateEvents(sessionId);
    game.send({ t: 'events', sessionId, events: events.slice(0, 10) });
    await adminUi.waitFor((m) => m.t === 'mirror' && m.mirror.lastSeq === 9);

    adminUi.send({ t: 'disconnect' });
    await adminUi.waitFor((m) => m.t === 'peer' && m.peer.state === 'disconnected');
    game.send({ t: 'events', sessionId, events: events.slice(10) });
    await game.waitFor((m) => m.t === 'ack' && m.seq === events.at(-1)!.seq);

    adminUi.send({ t: 'connect', address }); // no code: uses the stored pairing
    await adminUi.waitFor((m) => m.t === 'mirror' && m.mirror.lastSeq === events.at(-1)!.seq, 5000);
  });

  it('keeps only the current session open; late events for an earlier one still land in its files', async () => {
    const { game } = await setup();
    const open = async (sessionId: string) => {
      game.send({ t: 'session.open', sessionId, participantId: 'P9', version: 'test', startedAt: new Date().toISOString(), config: DEFAULT_CONFIG });
      return (await game.waitFor((m) => m.t === 'session.opened' && m.sessionId === sessionId)).logDir as string;
    };
    const acked = (sessionId: string, seq: number) => game.waitFor((m) => m.t === 'ack' && m.sessionId === sessionId && m.seq === seq);
    const a = generateEvents('late-a');
    const b = generateEvents('late-b');

    const dirA = await open('late-a');
    game.send({ t: 'events', sessionId: 'late-a', events: a.slice(0, 10) });
    await acked('late-a', 9);
    const dirB = await open('late-b'); // closes late-a
    game.send({ t: 'events', sessionId: 'late-b', events: b.slice(0, 10) });
    await acked('late-b', 9);
    game.send({ t: 'events', sessionId: 'late-a', events: a.slice(5) }); // overlaps what's stored: deduplicated
    await acked('late-a', a.at(-1)!.seq);
    game.send({ t: 'events', sessionId: 'late-b', events: b.slice(10) });
    await acked('late-b', b.at(-1)!.seq);

    const seqs = (dir: string) => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).seq);
    expect(seqs(dirA)).toEqual(a.map((e) => e.seq));
    expect(seqs(dirB)).toEqual(b.map((e) => e.seq));
  });

  it('accepts sessions recorded by an older app version (config missing newer fields)', async () => {
    const { game } = await setup();
    const { appearance: _dropped, ...oldConfig } = DEFAULT_CONFIG;
    game.send({ t: 'session.open', sessionId: 'old-1', participantId: 'P0', version: '2.0.0-alpha.0', startedAt: new Date().toISOString(), config: oldConfig });
    const opened = await game.waitFor((m) => m.t === 'session.opened' || m.t === 'error');
    expect(opened.t).toBe('session.opened');
    expect(JSON.parse(fs.readFileSync(path.join(opened.logDir, 'config.json'), 'utf8'))).toEqual(oldConfig);
  });

  it('rejects a wrong pairing code and does not retry it', async () => {
    const { adminUi, address } = await setup();
    adminUi.send({ t: 'connect', address, pairingCode: '0000-0000-0000-0000-0000-0000-00' });
    const err = await adminUi.waitFor((m) => m.t === 'peer' && m.peer.state === 'error');
    expect(err.peer.error).toMatch(/not recognised/);
  });

  it('control API on the participant machine: a local program drives the game', async () => {
    const { p, game } = await setup();
    const sessionId = 'sess-api';
    game.send({ t: 'session.open', sessionId, participantId: 'P1', version: 'test', startedAt: new Date().toISOString(), config: DEFAULT_CONFIG });
    await game.waitFor((m) => m.t === 'session.opened');
    // The (fake) game page answers every command with the experiment's remote-command event.
    let seq = 0;
    game.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t !== 'cmd') return;
      const env = { schema: 1, sessionId, seq: seq++, tWall: Date.now(), event: { type: 'remote-command', command: m.command, accepted: true, source: m.source, tExp: 0, tSys: 0 } };
      game.send({ t: 'events', sessionId, events: [env] });
    });

    const res = await fetch(`http://127.0.0.1:${p.port}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'block-start' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, accepted: true });
    const cmd = await game.waitFor((m) => m.t === 'cmd');
    expect(cmd).toEqual({ t: 'cmd', command: 'block-start', source: 'control-api@local' });

    const st = await (await fetch(`http://127.0.0.1:${p.port}/api/status`)).json();
    expect(st.connected).toBe(true);
  });

  it('control API on the admin machine: commands are forwarded over the encrypted link', async () => {
    const { a, game, adminUi, code, address } = await setup();
    adminUi.send({ t: 'connect', address, pairingCode: code });
    await adminUi.waitFor((m) => m.t === 'peer' && m.peer.state === 'connected');
    const ev = await client(`ws://127.0.0.1:${a.port}/api/events`);
    await ev.waitFor((m) => m.t === 'status');
    ev.send({ t: 'cmd', command: 'quit' });
    const cmd = await game.waitFor((m) => m.t === 'cmd');
    expect(cmd.command).toBe('quit');
    expect(cmd.source).toMatch(/^control-api@a-[0-9a-f]+$/);
  });

  it('control API refuses browsers and malformed requests', async () => {
    const { p, game } = await setup();
    const url = `http://127.0.0.1:${p.port}/api/command`;
    const body = JSON.stringify({ command: 'block-start' });
    // A web page can only send text/plain without a preflight: refused.
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"command":"jump"}' })).status).toBe(400);
    // No game page open: nothing can receive the command.
    game.ws.close();
    await waitUntil(() => !p.participant!.connected);
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(r.status).toBe(409);
    await expect(client(`ws://127.0.0.1:${p.port}/api/events`, { Origin: 'http://evil.example' })).rejects.toThrow(/403/);
  });

  it('refuses UI connections from a foreign Origin', async () => {
    const { p } = await setup();
    await expect(client(`ws://127.0.0.1:${p.port}/ui`, { Origin: 'http://evil.example' })).rejects.toThrow(/403/);
  });
});
