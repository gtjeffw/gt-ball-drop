/**
 * A bidirectional, ordered message pipe. This is the Transport port: a LAN WebSocket
 * today, a relay WebSocket later, an in-memory pair in tests. The security layer sits on
 * top of it and doesn't care which one it gets.
 */
export type Frame = string | Uint8Array;

export interface MessageDuplex {
  send(data: Frame): void;
  /** Sets the one message handler, replacing any previous one. */
  onMessage(cb: (data: Frame) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(reason?: string): void;
  readonly isOpen: boolean;
}

/** The subset of the WebSocket API shared by browsers and the `ws` package. */
export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { reason?: string; code?: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export function webSocketDuplex(ws: WebSocketLike): MessageDuplex {
  ws.binaryType = 'arraybuffer';
  let onMsg: (d: Frame) => void = () => {};
  const closeCbs: ((r: string) => void)[] = [];
  let closed = false;
  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb(reason);
  };
  ws.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === 'string') onMsg(d);
    else if (d instanceof ArrayBuffer) onMsg(new Uint8Array(d));
    else if (ArrayBuffer.isView(d)) onMsg(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  };
  ws.onclose = (ev) => fireClose(ev.reason || `closed (${ev.code ?? '?'})`);
  ws.onerror = () => fireClose('socket error');
  return {
    send: (data) => ws.send(data),
    onMessage: (cb) => (onMsg = cb),
    onClose: (cb) => void closeCbs.push(cb),
    close: (reason) => {
      ws.close(1000, reason);
      fireClose(reason ?? 'closed');
    },
    get isOpen() {
      return !closed && ws.readyState === 1;
    },
  };
}

/** Two connected in-memory duplexes, for tests. Delivery is async, like a real socket. */
export function duplexPair(): [MessageDuplex, MessageDuplex] {
  const make = () => ({ onMsg: (_: Frame) => {}, closeCbs: [] as ((r: string) => void)[], closed: false });
  const a = make();
  const b = make();
  const end = (self: ReturnType<typeof make>, other: ReturnType<typeof make>): MessageDuplex => ({
    send: (d) => {
      if (self.closed) throw new Error('duplex closed');
      const copy = typeof d === 'string' ? d : d.slice();
      queueMicrotask(() => !other.closed && other.onMsg(copy));
    },
    onMessage: (cb) => (self.onMsg = cb),
    onClose: (cb) => void self.closeCbs.push(cb),
    close: (reason = 'closed') => {
      // Like a real socket, frames already sent are delivered before the close.
      self.closed = true;
      queueMicrotask(() => {
        for (const s of [self, other]) {
          s.closed = true;
          s.closeCbs.splice(0).forEach((cb) => cb(reason));
        }
      });
    },
    get isOpen() {
      return !self.closed;
    },
  });
  return [end(a, b), end(b, a)];
}
