import { z } from 'zod';
import { EventEnvelopeSchema } from './events';
import type { ControlCommand, EventEnvelope } from './events';
import type { ExperimentConfig } from './config';
import type { ExperimentStatus } from './status';

/**
 * Messages between the processes. Two kinds of link:
 *
 *  - UI link: a page (game or admin UI) talking to the host on its own machine. Plain JSON
 *    over a loopback WebSocket.
 *  - Peer link: participant host <-> admin host. The same JSON, but always carried inside a
 *    SecureChannel (@gtbd/secure), whatever the transport (LAN now, a relay later).
 *
 * Inbound messages are validated with the zod schemas below. Outbound ones use the TS types.
 */

const AdminCommandSchema = z.enum(['block-start', 'block-end', 'quit']);
const StatusSchema = z.looseObject({ phase: z.string() }); // the host passes it through, so validate loosely

// ---- game UI <-> participant host ------------------------------------------------------

export const GameToHostSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('session.open'),
    sessionId: z.string().min(1),
    participantId: z.string().min(1),
    version: z.string(),
    startedAt: z.string(),
    // Stored verbatim as the session's config snapshot. Validated loosely, so sessions
    // recorded by an older app version (e.g. still in a page's outbox) are always accepted.
    config: z.looseObject({}),
  }),
  z.object({ t: z.literal('events'), sessionId: z.string(), events: z.array(EventEnvelopeSchema) }),
  z.object({ t: z.literal('status'), status: StatusSchema }),
  z.object({ t: z.literal('pairing.new') }),
  z.object({ t: z.literal('app.quit') }),
]);
export type GameToHost =
  /** The page running the core creates the session id, so browser-only (and later cloud) capture works the same way. */
  | { t: 'session.open'; sessionId: string; participantId: string; version: string; startedAt: string; config: ExperimentConfig }
  | { t: 'events'; sessionId: string; events: EventEnvelope[] }
  | { t: 'status'; status: ExperimentStatus }
  | { t: 'pairing.new' }
  | { t: 'app.quit' };

export type HostToGame =
  | { t: 'hello'; role: 'participant'; hostId: string; config: ExperimentConfig; pairingCode: string | null }
  | { t: 'session.opened'; sessionId: string; logDir: string }
  | { t: 'ack'; sessionId: string; seq: number }
  | { t: 'cmd'; command: ControlCommand; source: string }
  | { t: 'admin-link'; status: 'connected' | 'lost'; peerId: string }
  | { t: 'clock-sync'; peerId: string; offsetMs: number; rttMs: number }
  | { t: 'pairing'; code: string | null }
  | { t: 'error'; message: string };

// ---- admin UI <-> admin host -----------------------------------------------------------

export const AdminUiToHostSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('connect'), address: z.string().min(1), pairingCode: z.string().optional() }),
  z.object({ t: z.literal('disconnect') }),
  z.object({ t: z.literal('cmd'), command: AdminCommandSchema }),
]);
export type AdminUiToHost =
  | { t: 'connect'; address: string; pairingCode?: string }
  | { t: 'disconnect' }
  | { t: 'cmd'; command: ControlCommand };

export interface PeerSummary {
  address: string;
  state: 'disconnected' | 'connecting' | 'handshaking' | 'connected' | 'error';
  peerId: string | null;
  error: string | null;
  clock: { offsetMs: number; rttMs: number } | null;
}

export interface MirrorSummary {
  sessionId: string;
  participantId: string | null;
  lastSeq: number;
  dir: string;
}

export type AdminHostToUi =
  | { t: 'hello'; role: 'admin'; hostId: string; knownPeers: string[] }
  | { t: 'peer'; peer: PeerSummary }
  | { t: 'status'; status: ExperimentStatus | null }
  | { t: 'mirror'; mirror: MirrorSummary }
  | { t: 'event'; envelope: EventEnvelope }
  | { t: 'error'; message: string };

// ---- participant host <-> admin host (inside the SecureChannel) ------------------------

export const PeerMessageSchema = z.discriminatedUnion('t', [
  // admin -> participant
  z.object({ t: z.literal('cmd'), command: AdminCommandSchema, source: z.string().max(64).optional() }),
  z.object({ t: z.literal('sync'), sessionId: z.string().nullable(), lastSeq: z.number().int() }),
  z.object({ t: z.literal('ack'), sessionId: z.string(), seq: z.number().int() }),
  z.object({ t: z.literal('ping'), t0: z.number() }),
  z.object({ t: z.literal('clock'), offsetMs: z.number(), rttMs: z.number() }),
  // participant -> admin
  z.object({ t: z.literal('status'), status: StatusSchema.nullable() }),
  z.object({ t: z.literal('session'), sessionId: z.string(), participantId: z.string(), startedAt: z.string(), appVersion: z.string() }),
  z.object({ t: z.literal('events'), sessionId: z.string(), events: z.array(EventEnvelopeSchema) }),
  z.object({ t: z.literal('pong'), t0: z.number(), t1: z.number() }),
]);
export type PeerMessage =
  /** source: 'admin-panel' or 'control-api' */
  | { t: 'cmd'; command: ControlCommand; source?: string }
  | { t: 'sync'; sessionId: string | null; lastSeq: number }
  | { t: 'ack'; sessionId: string; seq: number }
  | { t: 'ping'; t0: number }
  | { t: 'clock'; offsetMs: number; rttMs: number }
  | { t: 'status'; status: ExperimentStatus | null }
  | { t: 'session'; sessionId: string; participantId: string; startedAt: string; appVersion: string }
  | { t: 'events'; sessionId: string; events: EventEnvelope[] }
  | { t: 'pong'; t0: number; t1: number };
