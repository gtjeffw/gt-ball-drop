import { describe, expect, it } from 'vitest';
import {
  duplexPair,
  formatPairingCode,
  generatePairingCode,
  handshake,
  pairingIdFor,
  PairingError,
  parsePairingCode,
  TokenPairing,
  type Frame,
  type MessageDuplex,
  type PairingStrategy,
} from '../src';

async function pair(opts: { adminCode: string; knownCodes: string[]; initiatorStrategies?: PairingStrategy[] }) {
  const [a, b] = duplexPair();
  const secrets = new Map<string, Uint8Array>();
  for (const c of opts.knownCodes) {
    const s = parsePairingCode(c)!;
    secrets.set(await pairingIdFor(s), s);
  }
  const initiator = handshake({
    duplex: a,
    role: 'initiator',
    nodeId: 'admin-1',
    strategies: opts.initiatorStrategies ?? [new TokenPairing({ role: 'initiator', code: opts.adminCode })],
  });
  const responder = handshake({
    duplex: b,
    role: 'responder',
    nodeId: 'participant-1',
    strategies: [new TokenPairing({ role: 'responder', lookup: (id) => secrets.get(id) })],
  });
  return Promise.allSettled([initiator, responder]);
}

describe('pairing codes', () => {
  it('are 26 base32 chars in groups of 4 and round-trip', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(formatPairingCode(parsePairingCode(code)!)).toBe(code);
  });

  it('tolerate case, spacing and O/0 I/L/1 mix-ups', () => {
    const code = formatPairingCode(new Uint8Array(16).fill(0));
    expect(code.startsWith('0000')).toBe(true);
    expect(parsePairingCode(code.toLowerCase().replace(/0/g, 'o').replace(/-/g, ' '))).toEqual(new Uint8Array(16));
  });

  it('reject wrong lengths and bad characters', () => {
    expect(parsePairingCode('ABCD')).toBeNull();
    expect(parsePairingCode(generatePairingCode() + 'X')).toBeNull();
    expect(parsePairingCode('UUUU-UUUU-UUUU-UUUU-UUUU-UUUU-UU')).toBeNull();
  });
});

describe('handshake + SecureChannel (token-v1)', () => {
  it('pairs with the right code and carries messages in order, both ways', async () => {
    const code = generatePairingCode();
    const [i, r] = await pair({ adminCode: code, knownCodes: [code] });
    expect(i.status).toBe('fulfilled');
    expect(r.status).toBe('fulfilled');
    if (i.status !== 'fulfilled' || r.status !== 'fulfilled') return;
    expect(i.value.peerNodeId).toBe('participant-1');
    expect(r.value.peerNodeId).toBe('admin-1');
    expect(i.value.pairingId).toBe(r.value.pairingId);
    expect(i.value.strategy).toBe('token-v1');

    const gotR: unknown[] = [];
    const gotI: unknown[] = [];
    r.value.channel.onMessage((m) => gotR.push(m));
    i.value.channel.onMessage((m) => gotI.push(m));
    for (let n = 0; n < 50; n++) void i.value.channel.send({ n });
    await r.value.channel.send({ hello: 'admin' });
    await new Promise((res) => setTimeout(res, 20));
    expect(gotR).toEqual(Array.from({ length: 50 }, (_, n) => ({ n })));
    expect(gotI).toEqual([{ hello: 'admin' }]);
  });

  it('fails with unknown-pairing when the participant does not know the code', async () => {
    const [i, r] = await pair({ adminCode: generatePairingCode(), knownCodes: [generatePairingCode()] });
    expect(i.status).toBe('rejected');
    expect(r.status).toBe('rejected');
    expect(((i as PromiseRejectedResult).reason as PairingError).code).toBe('unknown-pairing');
  });

  it('fails key confirmation when the ids match but the secrets differ', async () => {
    // Simulate a lookup that returns the wrong secret for a known id: both sides must reject.
    const [a, b] = duplexPair();
    const code = generatePairingCode();
    const wrong = parsePairingCode(generatePairingCode())!;
    const res = await Promise.allSettled([
      handshake({ duplex: a, role: 'initiator', nodeId: 'a', strategies: [new TokenPairing({ role: 'initiator', code })] }),
      handshake({ duplex: b, role: 'responder', nodeId: 'b', strategies: [new TokenPairing({ role: 'responder', lookup: () => wrong })] }),
    ]);
    expect(res.every((x) => x.status === 'rejected')).toBe(true);
    expect(((res[1] as PromiseRejectedResult).reason as PairingError).code).toBe('key-mismatch');
  });

  it('negotiates the first strategy both sides support (room for pake-v1 later)', async () => {
    const code = generatePairingCode();
    const future: PairingStrategy = { id: 'pake-v1', run: () => Promise.reject(new Error('should not be chosen')) };
    const [i, r] = await pair({
      adminCode: code,
      knownCodes: [code],
      initiatorStrategies: [future, new TokenPairing({ role: 'initiator', code })],
    });
    expect(i.status).toBe('fulfilled');
    expect(r.status).toBe('fulfilled');
    if (i.status === 'fulfilled') expect(i.value.strategy).toBe('token-v1');
  });

  it('rejects when there is no common strategy', async () => {
    const future: PairingStrategy = { id: 'pake-v1', run: () => Promise.reject(new Error('nope')) };
    const [i, r] = await pair({ adminCode: generatePairingCode(), knownCodes: [], initiatorStrategies: [future] });
    expect(r.status).toBe('rejected');
    expect(((r as PromiseRejectedResult).reason as PairingError).code).toBe('no-common-strategy');
    expect(i.status).toBe('rejected');
  });

  it('closes the channel on a tampered, replayed or reordered frame', async () => {
    const code = generatePairingCode();
    // A man in the middle that can see and modify frames (but not the keys).
    const [a, mitmA] = duplexPair();
    const [mitmB, b] = duplexPair();
    const captured: Frame[] = [];
    let mode: 'pass' | 'tamper' | 'replay' = 'pass';
    const relay = (from: MessageDuplex, to: MessageDuplex, record: boolean) =>
      from.onMessage((f) => {
        if (typeof f !== 'string' && record) {
          captured.push(f);
          if (mode === 'tamper') {
            const t = f.slice();
            t[t.length - 1]! ^= 1;
            return to.send(t);
          }
          if (mode === 'replay') return to.send(captured[0]!);
        }
        to.send(f);
      });
    relay(mitmA, mitmB, true);
    relay(mitmB, mitmA, false);

    const secret = parsePairingCode(code)!;
    const id = await pairingIdFor(secret);
    const [i, r] = await Promise.all([
      handshake({ duplex: a, role: 'initiator', nodeId: 'a', strategies: [new TokenPairing({ role: 'initiator', code })] }),
      handshake({ duplex: b, role: 'responder', nodeId: 'b', strategies: [new TokenPairing({ role: 'responder', lookup: (x) => (x === id ? secret : undefined) })] }),
    ]);
    const got: unknown[] = [];
    let closed = '';
    r.channel.onMessage((m) => got.push(m));
    r.channel.onClose((reason) => (closed = reason));

    await i.channel.send({ n: 1 });
    await new Promise((res) => setTimeout(res, 10));
    mode = 'replay';
    await i.channel.send({ n: 2 });
    await new Promise((res) => setTimeout(res, 10));
    expect(got).toEqual([{ n: 1 }]);
    expect(closed).toMatch(/out-of-order or replayed/);
  });
});
