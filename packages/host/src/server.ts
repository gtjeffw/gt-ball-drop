import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  port: number;
  /** '0.0.0.0' when LAN peers must reach us (participant), '127.0.0.1' otherwise. */
  bindAddress: string;
  /** Built UI to serve at '/'. Null means no static UI (dev: Vite serves it). */
  staticDir: string | null;
  /** Extra origins allowed on /ui, e.g. the Vite dev server. */
  extraOrigins: string[];
  onUi(ws: WebSocket): void;
  onPeer?(ws: WebSocket, remote: string): void;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

/**
 * One HTTP server per host:
 *   GET  /*     the built UI; loopback only
 *   WS   /ui    the local UI link; loopback only, with an Origin allowlist (a random web
 *               page in the local browser must not be able to drive the experiment)
 *   WS   /peer  the peer link; reachable from the LAN, but useless without the pairing
 *               secret (see @gtbd/secure)
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    serveStatic(opts.staticDir, req, res);
  });
  const uiWss = new WebSocketServer({ noServer: true });
  const peerWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  const allowedOrigins = () => {
    const port = (server.address() as AddressInfo).port;
    return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...opts.extraOrigins]);
  };

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const remote = req.socket.remoteAddress;
    if (url.pathname === '/ui') {
      const origin = req.headers.origin;
      if (!isLoopback(remote) || (origin !== undefined && !allowedOrigins().has(origin))) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      uiWss.handleUpgrade(req, socket, head, (ws) => opts.onUi(ws));
    } else if (url.pathname === '/peer' && opts.onPeer) {
      peerWss.handleUpgrade(req, socket, head, (ws) => opts.onPeer!(ws, remote ?? '?'));
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bindAddress, () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const c of uiWss.clients) c.terminate();
        for (const c of peerWss.clients) c.terminate();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function serveStatic(root: string | null, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!root || !fs.existsSync(root)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('UI not built. Run `npm run build:web`, or use the Vite dev server.');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const base = path.resolve(root);
  let file = path.resolve(base, rel || 'index.html');
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
