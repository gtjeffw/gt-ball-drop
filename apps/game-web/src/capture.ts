import { legacyHeader, legacyLines } from '@gtbd/core';
import type { EventEnvelope, ExperimentStatus, HostToGame } from '@gtbd/protocol';
import { IndexedDbOutboxStore, Replicator } from '@gtbd/sinks';
import { HostLink, hostTarget, type SessionInfo } from './host-link';

/**
 * Where a session's data goes. The game page runs the same way in both cases:
 *
 *  - host: the local participant host (desktop app / dev server). Events go through the
 *    IndexedDB outbox to the host, which writes the session folder. Remote control works.
 *  - demo: a static website with no server. The session is kept in memory, and at the end
 *    the participant can download it. Nothing leaves the browser.
 */
export interface Capture {
  readonly kind: 'host' | 'demo';
  /** Set when connected to a host at startup. */
  readonly hello: Extract<HostToGame, { t: 'hello' }> | null;
  openSession(info: SessionInfo): void;
  record(envelopes: EventEnvelope[]): void;
  status(status: ExperimentStatus): void;
  /** Called when the session is over. Resolves with what to tell the participant. */
  finish(): Promise<FinishResult>;
  newPairingCode(): void;
}

export interface FinishResult {
  saved: boolean;
  message: string;
  downloads: { name: string; label: string; blob: Blob }[];
}

export async function hostCapture(onMessage: (m: HostToGame) => void): Promise<Capture> {
  const link = new HostLink(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ui`);
  const hello = await link.start();
  // Subscribe after the first hello: the caller handles that one from the return value.
  link.on(onMessage);
  // Local-first: every event goes to the browser's IndexedDB outbox, then to the host,
  // which fsyncs and acks. A cloud target would be one more entry in this list.
  const replicator = new Replicator(new IndexedDbOutboxStore(), [hostTarget(link)]);
  replicator.start();
  return {
    kind: 'host',
    hello,
    openSession: (info) => link.registerSession(info),
    record: (envelopes) => void replicator.append(envelopes),
    status: (status) => void link.send({ t: 'status', status }),
    newPairingCode: () => void link.send({ t: 'pairing.new' }),
    finish: async () => {
      const deadline = performance.now() + 5000;
      while (!(await replicator.drained()) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const saved = await replicator.drained();
      link.send({ t: 'app.quit' });
      return {
        saved,
        message: saved
          ? 'Session saved. You may close this window.'
          : 'Could not reach the local host: data is kept in browser storage and will be sent when it is back.',
        downloads: [],
      };
    },
  };
}

export function demoCapture(): Capture {
  const envelopes: EventEnvelope[] = [];
  let info: SessionInfo | null = null;
  return {
    kind: 'demo',
    hello: null,
    openSession: (i) => void (info = i),
    record: (batch) => void envelopes.push(...batch),
    status: () => {},
    newPairingCode: () => {},
    finish: async () => {
      if (!info) return { saved: false, message: 'No session was recorded.', downloads: [] };
      const stem = `${info.startedAt.slice(0, 19).replace(/[T:]/g, '-')}_${info.participantId.replace(/[^\w.-]+/g, '_')}`;
      const jsonl = envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const legacy = legacyHeader(new Date(info.startedAt)) + envelopes.map((e) => legacyLines(e.event)).join('');
      return {
        saved: true,
        message: 'Demo complete. Nothing was uploaded; download the session data below if you want it.',
        downloads: [
          { name: `${stem}_events.jsonl`, label: 'events.jsonl', blob: new Blob([jsonl], { type: 'application/x-ndjson' }) },
          { name: `${stem}_event_log.txt`, label: 'event_log.txt', blob: new Blob([legacy], { type: 'text/plain' }) },
          { name: `${stem}_config.json`, label: 'config.json', blob: new Blob([JSON.stringify(info.config, null, 2) + '\n'], { type: 'application/json' }) },
        ],
      };
    },
  };
}

