import type http from 'node:http';
import type { WebSocket } from 'ws';
import type { ControlCommand, EventEnvelope, ExperimentStatus } from '@gtbd/protocol';

/**
 * The control API: how another program (a primary task, a script) drives the experiment.
 * Both hosts serve it on their own machine, on the same port as the UI:
 *
 *   GET  /api/status                         -> { connected, status }
 *   POST /api/command  {"command": "..."}    -> { sent, accepted }
 *   WS   /api/events                         <- { t: 'status' | 'event', ... }
 *                                            -> { t: 'cmd', command }
 *
 * On the participant machine commands go straight to the game. On the admin machine they
 * are forwarded over the encrypted link, so a program there needs no crypto of its own.
 * Loopback only, and browsers are kept out (see server.ts), so a web page can't use it.
 */
export interface ControlBackend {
  /** Whether a command can reach the experiment right now. */
  readonly connected: boolean;
  readonly status: ExperimentStatus | null;
  /** Send a command. Returns an error message, or null if it was sent. */
  send(command: ControlCommand): string | null;
  subscribe(listener: (m: ControlMessage) => void): () => void;
}

export type ControlMessage = { t: 'status'; status: ExperimentStatus | null } | { t: 'event'; envelope: EventEnvelope };

const COMMANDS: readonly ControlCommand[] = ['block-start', 'block-end', 'quit'];
const CONFIRM_TIMEOUT_MS = 2000;

/** A small fan-out helper for backends. */
export class ControlFeed {
  private readonly listeners = new Set<(m: ControlMessage) => void>();
  subscribe(listener: (m: ControlMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  status(status: ExperimentStatus | null): void {
    for (const l of this.listeners) l({ t: 'status', status });
  }
  events(envelopes: EventEnvelope[]): void {
    for (const envelope of envelopes) for (const l of this.listeners) l({ t: 'event', envelope });
  }
}

export class ControlApi {
  constructor(private readonly backend: ControlBackend) {}

  async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body) + '\n');
    };
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return reply(200, { connected: this.backend.connected, status: this.backend.status });
    }
    if (req.method === 'POST' && url.pathname === '/api/command') {
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return reply(415, { error: 'Content-Type must be application/json' });
      }
      let command: unknown;
      try {
        command = (JSON.parse(await readBody(req)) as { command?: unknown }).command;
      } catch {
        return reply(400, { error: 'Body must be JSON: {"command": "block-start" | "block-end" | "quit"}' });
      }
      if (!COMMANDS.includes(command as ControlCommand)) {
        return reply(400, { error: `Unknown command ${JSON.stringify(command)}; use one of ${COMMANDS.join(', ')}` });
      }
      const result = await this.sendAndConfirm(command as ControlCommand);
      return result.error ? reply(409, { sent: false, error: result.error }) : reply(200, { sent: true, accepted: result.accepted });
    }
    reply(404, { error: 'Not found. Endpoints: GET /api/status, POST /api/command, WS /api/events' });
  }

  handleWs(ws: WebSocket): void {
    const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    send({ t: 'status', status: this.backend.status, connected: this.backend.connected });
    const unsubscribe = this.backend.subscribe(send);
    ws.on('close', unsubscribe);
    ws.on('message', (raw) => {
      let msg: { t?: unknown; command?: unknown };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send({ t: 'error', error: 'bad JSON' });
      }
      if (msg.t !== 'cmd' || !COMMANDS.includes(msg.command as ControlCommand)) {
        return send({ t: 'error', error: `Expected {"t": "cmd", "command": ${COMMANDS.map((c) => `"${c}"`).join(' | ')}}` });
      }
      const error = this.backend.send(msg.command as ControlCommand);
      if (error) send({ t: 'error', error });
      // Acceptance arrives as a normal 'remote-command' event on this socket.
    });
  }

  /** Send, then wait briefly for the experiment's own 'remote-command' event to learn whether it was accepted. */
  private sendAndConfirm(command: ControlCommand): Promise<{ error?: string; accepted: boolean | null }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve({ accepted: null });
      }, CONFIRM_TIMEOUT_MS);
      const unsubscribe = this.backend.subscribe((m) => {
        if (m.t === 'event' && m.envelope.event.type === 'remote-command' && m.envelope.event.command === command) {
          clearTimeout(timer);
          unsubscribe();
          resolve({ accepted: m.envelope.event.accepted });
        }
      });
      const error = this.backend.send(command);
      if (error) {
        clearTimeout(timer);
        unsubscribe();
        resolve({ error, accepted: null });
      }
    });
  }
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > limit) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
