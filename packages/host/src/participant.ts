import fs from 'node:fs';
import path from 'node:path';
import type { WebSocket } from 'ws';
import {
  GameToHostSchema,
  PeerMessageSchema,
  type ControlCommand,
  type EventEnvelope,
  type ExperimentConfig,
  type ExperimentStatus,
  type HostToGame,
  type PeerMessage,
} from '@gtbd/protocol';
import {
  generatePairingCode,
  handshake,
  pairingIdFor,
  parsePairingCode,
  TokenPairing,
  webSocketDuplex,
  type SecureChannel,
  type WebSocketLike,
} from '@gtbd/secure';
import { SessionFiles } from '@gtbd/sinks/node';
import { ControlFeed, type ControlBackend } from './control-api';
import type { StateFile } from './state';

const PEER_BATCH = 500;

interface Peer {
  channel: SecureChannel;
  peerNodeId: string;
  /** Mirror cursor: the highest seq the admin has acknowledged for the current session, or null before it syncs. */
  cursor: number | null;
  syncedSession: string | null;
  inFlight: boolean;
}

export interface ParticipantHostOptions {
  dataDir: string;
  state: StateFile;
  config: ExperimentConfig;
  log: (msg: string) => void;
  onQuit?: () => void;
}

/**
 * The participant machine's host. It is the durable sink for the game page's events, the
 * primary copy of every session, and the source for admin mirrors.
 */
export class ParticipantHost implements ControlBackend {
  private readonly uiClients = new Set<WebSocket>();
  private readonly peers = new Set<Peer>();
  private readonly sessions = new Map<string, SessionFiles>();
  private current: SessionFiles | null = null;
  private latestStatus: ExperimentStatus | null = null;
  private readonly sessionsRoot: string;
  private readonly feed = new ControlFeed();

  constructor(private readonly opts: ParticipantHostOptions) {
    this.sessionsRoot = path.join(opts.dataDir, 'sessions');
    fs.mkdirSync(this.sessionsRoot, { recursive: true });
    if (!opts.state.state.pendingCode && opts.state.state.pairings.length === 0) this.newPairingCode();
    else if (opts.state.state.pendingCode) opts.log(`Pairing code for the admin machine: ${opts.state.state.pendingCode}`);
  }

  get pairingCode(): string | null {
    return this.opts.state.state.pendingCode;
  }

  newPairingCode(): string {
    const code = generatePairingCode();
    this.opts.state.state.pendingCode = code;
    this.opts.state.save();
    this.opts.log(`Pairing code for the admin machine: ${code}`);
    this.broadcastUi({ t: 'pairing', code });
    return code;
  }

  // ---- control API backend (a program on this machine) ------------------------------------

  get connected(): boolean {
    return this.uiClients.size > 0;
  }

  get status(): ExperimentStatus | null {
    return this.latestStatus;
  }

  send(command: ControlCommand): string | null {
    if (!this.connected) return 'The game page is not open';
    this.broadcastUi({ t: 'cmd', command, source: 'control-api@local' });
    return null;
  }

  subscribe(listener: Parameters<ControlBackend['subscribe']>[0]): () => void {
    return this.feed.subscribe(listener);
  }

  // ---- game UI link ---------------------------------------------------------------------

  handleUi(ws: WebSocket): void {
    this.uiClients.add(ws);
    this.opts.log(`Game page connected (${this.uiClients.size} open)`);
    ws.on('close', () => this.uiClients.delete(ws));
    this.sendUi(ws, {
      t: 'hello',
      role: 'participant',
      hostId: this.opts.state.state.hostId,
      config: this.opts.config,
      pairingCode: this.pairingCode,
    });
    for (const p of this.peers) this.sendUi(ws, { t: 'admin-link', status: 'connected', peerId: p.peerNodeId });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = GameToHostSchema.parse(JSON.parse(String(raw)));
      } catch (err) {
        this.sendUi(ws, { t: 'error', message: `bad message: ${String(err)}` });
        return;
      }
      switch (msg.t) {
        case 'session.open': {
          let sf = this.findSession(msg.sessionId);
          if (!sf) {
            sf = SessionFiles.create(
              this.sessionsRoot,
              { sessionId: msg.sessionId, participantId: msg.participantId, startedAt: msg.startedAt, appVersion: msg.version, copy: 'primary' },
              msg.config as ExperimentConfig,
            );
            this.sessions.set(msg.sessionId, sf);
            this.opts.log(`Session ${msg.sessionId} (${msg.participantId}) -> ${sf.dir}`);
          }
          this.setCurrent(sf);
          this.sendUi(ws, { t: 'session.opened', sessionId: msg.sessionId, logDir: sf.dir });
          break;
        }
        case 'events': {
          const sf = this.findSession(msg.sessionId);
          if (!sf) {
            this.sendUi(ws, { t: 'error', message: `unknown session ${msg.sessionId}` });
            return;
          }
          const before = sf.lastSeq;
          const seq = sf.append(msg.events as EventEnvelope[]);
          this.sendUi(ws, { t: 'ack', sessionId: msg.sessionId, seq });
          this.feed.events((msg.events as EventEnvelope[]).filter((e) => e.seq > before && e.seq <= seq));
          if (sf !== this.current) this.setCurrent(sf);
          for (const p of this.peers) this.pushToPeer(p);
          break;
        }
        case 'status':
          this.latestStatus = msg.status as unknown as ExperimentStatus;
          this.feed.status(this.latestStatus);
          for (const p of this.peers) void p.channel.send({ t: 'status', status: this.latestStatus } satisfies PeerMessage);
          break;
        case 'pairing.new':
          this.newPairingCode();
          break;
        case 'app.quit':
          this.opts.onQuit?.();
          break;
      }
    });
  }

  // ---- peer link (admin machines) --------------------------------------------------------

  async handlePeer(ws: WebSocket, remote: string): Promise<void> {
    const st = this.opts.state;
    const lookup = async (pairingId: string) => {
      const known = st.state.pairings.find((p) => p.pairingId === pairingId);
      if (known) return parsePairingCode(known.code) ?? undefined;
      const pending = st.state.pendingCode;
      if (pending) {
        const secret = parsePairingCode(pending);
        if (secret && (await pairingIdFor(secret)) === pairingId) return secret;
      }
      return undefined;
    };
    let result;
    try {
      result = await handshake({
        duplex: webSocketDuplex(ws as unknown as WebSocketLike),
        role: 'responder',
        nodeId: st.state.hostId,
        strategies: [new TokenPairing({ role: 'responder', lookup })],
      });
    } catch (err) {
      this.opts.log(`Peer ${remote} rejected: ${(err as Error).message}`);
      return;
    }

    // Remember the pairing. A pending code is used up once an admin pairs with it.
    const now = new Date().toISOString();
    let rec = st.state.pairings.find((p) => p.pairingId === result.pairingId);
    if (!rec && st.state.pendingCode) {
      rec = { pairingId: result.pairingId, code: st.state.pendingCode, address: null, peerNodeId: null, createdAt: now, lastUsedAt: null };
      st.state.pairings.push(rec);
      st.state.pendingCode = null;
      this.broadcastUi({ t: 'pairing', code: null });
    }
    if (rec) {
      rec.peerNodeId = result.peerNodeId;
      rec.lastUsedAt = now;
    }
    st.save();

    const peer: Peer = { channel: result.channel, peerNodeId: result.peerNodeId, cursor: null, syncedSession: null, inFlight: false };
    this.peers.add(peer);
    this.opts.log(`Admin ${result.peerNodeId} connected from ${remote}`);
    this.broadcastUi({ t: 'admin-link', status: 'connected', peerId: peer.peerNodeId });

    peer.channel.onClose((reason) => {
      this.peers.delete(peer);
      this.opts.log(`Admin ${peer.peerNodeId} disconnected: ${reason}`);
      this.broadcastUi({ t: 'admin-link', status: 'lost', peerId: peer.peerNodeId });
    });
    peer.channel.onMessage((raw) => {
      const parsed = PeerMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      this.handlePeerMessage(peer, parsed.data as PeerMessage);
    });

    void peer.channel.send({ t: 'status', status: this.latestStatus } satisfies PeerMessage);
    if (this.current) void peer.channel.send(this.sessionAnnouncement(this.current));
  }

  private handlePeerMessage(peer: Peer, msg: PeerMessage): void {
    switch (msg.t) {
      case 'cmd':
        this.broadcastUi({ t: 'cmd', command: msg.command, source: `${msg.source ?? 'admin-panel'}@${peer.peerNodeId}` });
        break;
      case 'sync':
        if (this.current && msg.sessionId === this.current.meta.sessionId) {
          peer.syncedSession = msg.sessionId;
          peer.cursor = msg.lastSeq;
          peer.inFlight = false;
          this.pushToPeer(peer);
        }
        break;
      case 'ack':
        if (msg.sessionId === peer.syncedSession) {
          peer.cursor = Math.max(peer.cursor ?? -1, msg.seq);
          peer.inFlight = false;
          this.pushToPeer(peer);
        }
        break;
      case 'ping':
        void peer.channel.send({ t: 'pong', t0: msg.t0, t1: Date.now() } satisfies PeerMessage);
        break;
      case 'clock':
        this.broadcastUi({ t: 'clock-sync', peerId: peer.peerNodeId, offsetMs: msg.offsetMs, rttMs: msg.rttMs });
        break;
      default:
        break;
    }
  }

  /** Send the admin the next batch it hasn't acknowledged. One batch in flight at a time. */
  private pushToPeer(peer: Peer): void {
    const sf = this.current;
    if (!sf || peer.syncedSession !== sf.meta.sessionId || peer.cursor === null || peer.inFlight) return;
    if (peer.cursor >= sf.lastSeq) return;
    const events = sf.readAfter(peer.cursor, PEER_BATCH);
    if (!events.length) return;
    peer.inFlight = true;
    void peer.channel.send({ t: 'events', sessionId: sf.meta.sessionId, events } satisfies PeerMessage);
  }

  private setCurrent(sf: SessionFiles): void {
    if (this.current === sf) return;
    this.current = sf;
    // Only the current session stays open (files and cached events). Late events for an
    // earlier one reopen it from disk.
    for (const [id, other] of this.sessions) {
      if (other === sf) continue;
      other.close();
      this.sessions.delete(id);
    }
    for (const p of this.peers) {
      p.syncedSession = null;
      p.cursor = null;
      p.inFlight = false;
      void p.channel.send(this.sessionAnnouncement(sf));
    }
  }

  private sessionAnnouncement(sf: SessionFiles): PeerMessage {
    return { t: 'session', sessionId: sf.meta.sessionId, participantId: sf.meta.participantId, startedAt: sf.meta.startedAt, appVersion: sf.meta.appVersion };
  }

  /** Find a session opened in this run, or on disk from an earlier run (the page's outbox may resend after a host restart). */
  private findSession(sessionId: string): SessionFiles | null {
    const open = this.sessions.get(sessionId);
    if (open) return open;
    for (const name of fs.readdirSync(this.sessionsRoot)) {
      const metaPath = path.join(this.sessionsRoot, name, 'session.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        if (JSON.parse(fs.readFileSync(metaPath, 'utf8')).sessionId === sessionId) {
          const sf = SessionFiles.open(path.join(this.sessionsRoot, name));
          this.sessions.set(sessionId, sf);
          return sf;
        }
      } catch {
        /* skip unreadable dirs */
      }
    }
    return null;
  }

  private sendUi(ws: WebSocket, msg: HostToGame): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastUi(msg: HostToGame): void {
    for (const ws of this.uiClients) this.sendUi(ws, msg);
  }

  close(): void {
    for (const p of this.peers) p.channel.close('host shutting down');
    for (const sf of this.sessions.values()) sf.close();
    this.sessions.clear();
  }
}
