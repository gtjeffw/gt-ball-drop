import { fromBase32, randomBytes, toBase32, toHex, utf8 } from './bytes';

/**
 * The pairing port. A strategy's only job is to give both sides the same high-entropy
 * `secret`. Everything after that (key schedule, key confirmation, the encrypted channel)
 * is shared, so a future `pake-v1` (short word codes via SPAKE2/CPace) is one new class
 * plus an entry in the hello's `pairing` list, and old clients still negotiate `token-v1`.
 */
export interface PairingContext {
  role: 'initiator' | 'responder';
  send(msg: Record<string, unknown>): void;
  receive(): Promise<Record<string, unknown>>;
}

export interface PairingResult {
  /** Input keying material for the session key schedule. */
  secret: Uint8Array;
  /** Stable id for this pairing, so both sides can remember it. */
  pairingId: string;
  /** Strategy messages to bind into the handshake transcript. */
  transcript: unknown[];
}

export interface PairingStrategy {
  readonly id: string;
  run(ctx: PairingContext): Promise<PairingResult>;
}

export class PairingError extends Error {
  constructor(
    readonly code: 'unknown-pairing' | 'bad-code' | 'protocol' | 'key-mismatch' | 'no-common-strategy' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

// ---- token-v1 ---------------------------------------------------------------------------

export const TOKEN_BYTES = 16; // 128 bits

/** A fresh pairing code: 26 Crockford base32 characters in groups of four. */
export function generatePairingCode(): string {
  return formatPairingCode(randomBytes(TOKEN_BYTES));
}

export function formatPairingCode(secret: Uint8Array): string {
  return toBase32(secret).match(/.{1,4}/g)!.join('-');
}

/** Parse a typed code. Case, dashes, spaces and O/0, I/L/1 mix-ups are all tolerated. */
export function parsePairingCode(code: string): Uint8Array | null {
  return fromBase32(code, TOKEN_BYTES);
}

/** Public id derived from the secret. Safe to send in the clear, and to use as a storage key. */
export async function pairingIdFor(secret: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8('gtbd pairing id v1') as BufferSource));
  return toHex(mac.slice(0, 8));
}

/**
 * token-v1: the pairing code *is* the shared secret. The initiator (admin) sends only its
 * derived id, and the responder (participant) looks the secret up. Nothing secret crosses
 * the wire, and 128 bits rules out offline guessing, so no PAKE is needed for a code this
 * long.
 */
export class TokenPairing implements PairingStrategy {
  readonly id = 'token-v1';

  constructor(
    private readonly opts:
      | { role: 'initiator'; code: string }
      | { role: 'responder'; lookup: (pairingId: string) => Uint8Array | undefined | Promise<Uint8Array | undefined> },
  ) {}

  async run(ctx: PairingContext): Promise<PairingResult> {
    if (this.opts.role === 'initiator') {
      const secret = parsePairingCode(this.opts.code);
      if (!secret) throw new PairingError('bad-code', 'Pairing code is not valid (expected 26 characters)');
      const pairingId = await pairingIdFor(secret);
      const hello = { t: 'token-v1', pairingId };
      ctx.send(hello);
      const reply = await ctx.receive();
      if (reply.t === 'error') throw new PairingError('unknown-pairing', String(reply.message ?? 'Pairing code not recognised'));
      if (reply.t !== 'token-v1' || reply.ok !== true) throw new PairingError('protocol', 'Unexpected token-v1 reply');
      return { secret, pairingId, transcript: [hello, reply] };
    }
    const msg = await ctx.receive();
    if (msg.t !== 'token-v1' || typeof msg.pairingId !== 'string') throw new PairingError('protocol', 'Expected token-v1 hello');
    const secret = await this.opts.lookup(msg.pairingId);
    if (!secret) {
      ctx.send({ t: 'error', code: 'unknown-pairing', message: 'Pairing code not recognised by the participant machine' });
      throw new PairingError('unknown-pairing', `Unknown pairing id ${msg.pairingId}`);
    }
    const reply = { t: 'token-v1', ok: true };
    ctx.send(reply);
    return { secret, pairingId: msg.pairingId, transcript: [msg, reply] };
  }
}
