import { legacyHeader, legacyLines } from '@gtbd/core';
import type { EventEnvelope, ExperimentStatus, HostToGame } from '@gtbd/protocol';
import { IndexedDbOutboxStore, Replicator, type OutboxStore } from '@gtbd/sinks';
import { zip } from './zip';
import { HostLink, hostTarget, type SessionInfo } from './host-link';

/**
 * Where a session's data goes. The game page runs the same way in both cases:
 *
 *  - host: the local participant host (desktop app / dev server). Events go through the
 *    IndexedDB outbox to the host, which writes the session folder. Remote control works.
 *  - browser: a static website with no server, for sessions run with an experimenter in the
 *    room. Events are kept in this browser's storage and downloaded at the end.
 */
export interface Capture {
  readonly kind: 'host' | 'browser';
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
  downloads: Download[];
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

/**
 * Browser mode: no host. Events go to this browser's IndexedDB as they happen, so a closed
 * or crashed tab loses nothing, and at the end the session is offered as one .zip download.
 * A session needs no separate metadata: its first event (session-started) records the
 * participant, version and full config, and its tWall is the start time.
 */
export interface BrowserCapture extends Capture {
  /** Sessions still in browser storage (e.g. from a tab that closed before its data was downloaded). */
  stored(): Promise<StoredSession[]>;
  exportSession(sessionId: string): Promise<Download>;
  discard(sessionId: string): Promise<void>;
}

export interface StoredSession {
  sessionId: string;
  participantId: string;
  startedAt: Date;
  events: number;
}

export interface Download {
  name: string;
  label: string;
  blob: Blob;
}

const ALL = Number.MAX_SAFE_INTEGER;

/** Every stored event of a session, read in pages (IndexedDB counts are 32-bit). */
async function readAll(store: OutboxStore, sessionId: string): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for (;;) {
    const page = await store.after(sessionId, out.at(-1)?.seq ?? -1, 10_000);
    out.push(...page);
    if (page.length < 10_000) return out;
  }
}

export function browserCapture(store: OutboxStore = new IndexedDbOutboxStore('gtbd-browser-sessions')): BrowserCapture {
  let current: string | null = null;
  let writes: Promise<void> = Promise.resolve();

  const exportSession = async (sessionId: string): Promise<Download> => {
    await writes;
    const envelopes = await readAll(store, sessionId);
    const first = envelopes[0];
    const started = first?.event.type === 'session-started' ? first.event : null;
    const participantId = started?.participantId ?? 'unknown';
    const startedAt = new Date(first?.tWall ?? Date.now());
    const p = (n: number) => String(n).padStart(2, '0');
    const stem = `${startedAt.getFullYear()}-${p(startedAt.getMonth() + 1)}-${p(startedAt.getDate())}_${p(startedAt.getHours())}-${p(startedAt.getMinutes())}-${p(startedAt.getSeconds())}_${participantId.replace(/[^\w.-]+/g, '_')}`;
    const files = [
      { name: `${stem}/events.jsonl`, data: envelopes.map((e) => JSON.stringify(e)).join('\n') + '\n' },
      { name: `${stem}/event_log.txt`, data: legacyHeader(startedAt) + envelopes.map((e) => legacyLines(e.event)).join('') },
      ...(started ? [{ name: `${stem}/config.json`, data: JSON.stringify(started.config, null, 2) + '\n' }] : []),
    ];
    return { name: `${stem}.zip`, label: 'session data (.zip)', blob: new Blob([zip(files, startedAt) as BlobPart], { type: 'application/zip' }) };
  };

  return {
    kind: 'browser',
    hello: null,
    openSession: (info) => void (current = info.sessionId),
    record: (batch) => {
      writes = writes.then(() => store.put(batch)).catch((err) => console.error('saving events failed', err));
    },
    status: () => {},
    newPairingCode: () => {},
    finish: async () => {
      if (!current) return { saved: false, message: 'No session was recorded.', downloads: [] };
      return { saved: true, message: 'Session finished. Download the session data?', downloads: [await exportSession(current)] };
    },
    stored: async () => {
      await writes;
      const out: StoredSession[] = [];
      for (const sessionId of await store.sessions()) {
        const envelopes = await readAll(store, sessionId);
        const first = envelopes[0];
        out.push({
          sessionId,
          participantId: first?.event.type === 'session-started' ? first.event.participantId : 'unknown',
          startedAt: new Date(first?.tWall ?? 0),
          events: envelopes.length,
        });
      }
      return out;
    },
    exportSession,
    discard: async (sessionId) => {
      await writes;
      await store.trim(sessionId, ALL);
    },
  };
}
