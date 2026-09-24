import { concat, fromUtf8, utf8 } from './bytes';
import type { Frame, MessageDuplex } from './duplex';

const COUNTER_BYTES = 8;

/**
 * An encrypted, authenticated, ordered JSON message channel over any MessageDuplex.
 *
 * Each direction has its own AES-256-GCM key. The 12-byte nonce is a 4-byte direction tag
 * followed by a 64-bit message counter. Frames must arrive with exactly the next counter
 * value, so a replayed, reordered or dropped frame closes the channel. That is safe
 * because every transport we use (WebSocket, relay) is reliable and ordered.
 */
export class SecureChannel {
  private sendCounter = 0n;
  private recvCounter = 0n;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private handler: ((msg: unknown) => void) | null = null;
  /** Messages that arrive before a handler is attached (right after the handshake) wait here. */
  private pending: unknown[] = [];
  private readonly closeCbs: ((reason: string) => void)[] = [];
  private closedReason: string | null = null;

  private constructor(
    private readonly duplex: MessageDuplex,
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
    private readonly sendTag: Uint8Array,
    private readonly recvTag: Uint8Array,
    readonly peerNodeId: string,
    readonly pairingId: string,
    readonly strategy: string,
  ) {
    duplex.onMessage((f) => this.receive(f));
    duplex.onClose((r) => this.markClosed(r));
  }

  static async create(opts: {
    duplex: MessageDuplex;
    sendKey: Uint8Array;
    recvKey: Uint8Array;
    role: 'initiator' | 'responder';
    peerNodeId: string;
    pairingId: string;
    strategy: string;
    /** Frames that arrived during the handshake, after the peer switched to encrypted frames. */
    pendingFrames?: Frame[];
  }): Promise<SecureChannel> {
    const imp = (k: Uint8Array, use: KeyUsage) => crypto.subtle.importKey('raw', k as BufferSource, 'AES-GCM', false, [use]);
    const i2r = utf8('I2R\0');
    const r2i = utf8('R2I\0');
    const [sendTag, recvTag] = opts.role === 'initiator' ? [i2r, r2i] : [r2i, i2r];
    const ch = new SecureChannel(
      opts.duplex,
      await imp(opts.sendKey, 'encrypt'),
      await imp(opts.recvKey, 'decrypt'),
      sendTag,
      recvTag,
      opts.peerNodeId,
      opts.pairingId,
      opts.strategy,
    );
    for (const f of opts.pendingFrames?.splice(0) ?? []) ch.receive(f);
    return ch;
  }

  get isOpen(): boolean {
    return this.closedReason === null && this.duplex.isOpen;
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.handler = cb;
    const queued = this.pending;
    this.pending = [];
    for (const m of queued) cb(m);
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closedReason !== null) cb(this.closedReason);
    else this.closeCbs.push(cb);
  }

  /** Queue a message. Messages go out in call order. Resolves once this one has been handed to the transport. */
  send(msg: unknown): Promise<void> {
    const counter = this.sendCounter++;
    const plaintext = utf8(JSON.stringify(msg));
    const p = this.sendChain.then(async () => {
      if (!this.isOpen) return;
      const ctr = counterBytes(counter);
      const iv = concat(this.sendTag, ctr);
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: ctr as BufferSource }, this.sendKey, plaintext as BufferSource),
      );
      if (this.isOpen) this.duplex.send(concat(ctr, ct));
    });
    this.sendChain = p.catch(() => {});
    return p;
  }

  close(reason = 'closed'): void {
    this.duplex.close(reason);
    this.markClosed(reason);
  }

  private receive(frame: Frame): void {
    this.recvChain = this.recvChain.then(async () => {
      if (!this.isOpen) return;
      if (typeof frame === 'string' || frame.length < COUNTER_BYTES + 16) return this.fail('malformed frame');
      const ctr = frame.subarray(0, COUNTER_BYTES);
      const counter = new DataView(ctr.buffer, ctr.byteOffset, COUNTER_BYTES).getBigUint64(0);
      if (counter !== this.recvCounter) return this.fail('out-of-order or replayed frame');
      let pt: Uint8Array;
      try {
        pt = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: concat(this.recvTag, ctr) as BufferSource, additionalData: ctr as BufferSource },
            this.recvKey,
            frame.subarray(COUNTER_BYTES) as BufferSource,
          ),
        );
      } catch {
        return this.fail('authentication failed');
      }
      this.recvCounter++;
      let msg: unknown;
      try {
        msg = JSON.parse(fromUtf8(pt));
      } catch {
        return this.fail('bad payload');
      }
      if (!this.handler) {
        this.pending.push(msg);
        return;
      }
      try {
        this.handler(msg);
      } catch (err) {
        console.error('SecureChannel message handler threw', err);
      }
    }).catch((err) => this.fail(`receive error: ${String(err)}`));
  }

  private fail(reason: string): void {
    this.close(`secure channel: ${reason}`);
  }

  private markClosed(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const cb of this.closeCbs) cb(reason);
  }
}

function counterBytes(n: bigint): Uint8Array {
  const b = new Uint8Array(COUNTER_BYTES);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}
