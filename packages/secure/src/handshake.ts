import { concat, equalBytes, fromBase64, randomBytes, toBase64, utf8 } from './bytes';
import { SecureChannel } from './channel';
import type { Frame, MessageDuplex } from './duplex';
import { PairingError, type PairingStrategy } from './pairing';

export interface HandshakeOptions {
  duplex: MessageDuplex;
  role: 'initiator' | 'responder';
  nodeId: string;
  /** Supported strategies, most preferred first. The responder picks the first one both sides support. */
  strategies: PairingStrategy[];
  timeoutMs?: number;
}

export interface HandshakeResult {
  channel: SecureChannel;
  peerNodeId: string;
  pairingId: string;
  strategy: string;
}

/**
 * Handshake, version 1:
 *
 *   I -> R  hello   { v, nodeId, role, pairing: [ids...], nonce }
 *   R -> I  hello   { v, nodeId, role, pairing, nonce, chosen }
 *   ...     messages from the chosen PairingStrategy, ending with a shared secret
 *   I -> R  confirm { mac }   HMAC(kConfirmI, transcript)
 *   R -> I  confirm { mac }   HMAC(kConfirmR, transcript)
 *   then    encrypted frames (SecureChannel)
 *
 * Keys = HKDF-SHA256(secret, salt = nonceI || nonceR, info = label || transcript hash), so
 * every connection gets fresh keys, and a hello that was tampered with (say, to downgrade
 * the strategy) fails the confirm step.
 */
export async function handshake(opts: HandshakeOptions): Promise<HandshakeResult> {
  const { duplex, role } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const queue: Frame[] = [];
  let waiter: { resolve: (f: Frame) => void; reject: (e: Error) => void } | null = null;
  let closedReason: string | null = null;
  duplex.onMessage((f) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w.resolve(f);
    } else queue.push(f);
  });
  duplex.onClose((r) => {
    closedReason = r;
    const w = waiter;
    waiter = null;
    w?.reject(new PairingError('protocol', `Connection closed: ${r}`));
  });

  const framesI: string[] = [];
  const framesR: string[] = [];
  const mine = role === 'initiator' ? framesI : framesR;
  const theirs = role === 'initiator' ? framesR : framesI;

  const send = (msg: Record<string, unknown>, record = true) => {
    const text = JSON.stringify(msg);
    if (record) mine.push(text);
    duplex.send(text);
  };
  const receive = async (record = true): Promise<Record<string, unknown>> => {
    const frame =
      queue.shift() ??
      (await new Promise<Frame>((resolve, reject) => {
        if (closedReason) return reject(new PairingError('protocol', `Connection closed: ${closedReason}`));
        const timer = setTimeout(() => {
          waiter = null;
          reject(new PairingError('timeout', 'Handshake timed out'));
        }, timeoutMs);
        waiter = {
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
      }));
    if (typeof frame !== 'string') throw new PairingError('protocol', 'Binary frame during handshake');
    const msg = JSON.parse(frame) as Record<string, unknown>;
    if (msg.t === 'error' && msg.code !== 'unknown-pairing') {
      throw new PairingError((msg.code as PairingError['code']) ?? 'protocol', String(msg.message ?? msg.code));
    }
    if (record) theirs.push(frame);
    return msg;
  };

  const fail = (err: unknown): never => {
    if (err instanceof PairingError && duplex.isOpen) {
      try {
        duplex.send(JSON.stringify({ t: 'error', code: err.code, message: err.message }));
      } catch {
        /* the socket is already gone */
      }
    }
    duplex.close(err instanceof Error ? err.message : 'handshake failed');
    throw err;
  };

  try {
    const ids = opts.strategies.map((s) => s.id);
    const nonce = randomBytes(32);
    const hello = { t: 'hello', v: 1, nodeId: opts.nodeId, role, pairing: ids, nonce: toBase64(nonce) };

    let peer: Record<string, unknown>;
    let chosen: string;
    if (role === 'initiator') {
      send(hello);
      peer = await receive();
      if (peer.t !== 'hello' || peer.v !== 1) throw new PairingError('protocol', 'Expected hello v1');
      chosen = String(peer.chosen);
      if (!ids.includes(chosen)) throw new PairingError('no-common-strategy', `Peer chose unsupported pairing "${chosen}"`);
    } else {
      peer = await receive();
      if (peer.t !== 'hello' || peer.v !== 1) throw new PairingError('protocol', 'Expected hello v1');
      const offered = Array.isArray(peer.pairing) ? (peer.pairing as unknown[]).map(String) : [];
      const pick = ids.find((id) => offered.includes(id));
      if (!pick) throw new PairingError('no-common-strategy', `No common pairing strategy (offered: ${offered.join(', ')})`);
      chosen = pick;
      send({ ...hello, chosen });
    }
    const peerNonce = fromBase64(String(peer.nonce));
    if (peerNonce.length !== 32) throw new PairingError('protocol', 'Bad nonce');

    const strategy = opts.strategies.find((s) => s.id === chosen)!;
    const result = await strategy.run({ role, send: (m) => send(m), receive: () => receive() });

    const transcript = await sha256(concat(lengthPrefixed(framesI), lengthPrefixed(framesR)));
    const salt = role === 'initiator' ? concat(nonce, peerNonce) : concat(peerNonce, nonce);
    const okm = await hkdf(result.secret, salt, concat(utf8('gtbd/v1 session keys'), transcript), 128);
    const kI2R = okm.slice(0, 32);
    const kR2I = okm.slice(32, 64);
    const cI = okm.slice(64, 96);
    const cR = okm.slice(96, 128);

    const myConfirm = await hmac(role === 'initiator' ? cI : cR, transcript);
    const expectConfirm = await hmac(role === 'initiator' ? cR : cI, transcript);
    const checkConfirm = (m: Record<string, unknown>) => {
      if (m.t !== 'confirm' || typeof m.mac !== 'string' || !equalBytes(fromBase64(m.mac), expectConfirm)) {
        throw new PairingError('key-mismatch', 'Key confirmation failed: pairing codes do not match');
      }
    };
    if (role === 'initiator') {
      send({ t: 'confirm', mac: toBase64(myConfirm) }, false);
      checkConfirm(await receive(false));
    } else {
      checkConfirm(await receive(false));
      send({ t: 'confirm', mac: toBase64(myConfirm) }, false);
    }

    const channel = await SecureChannel.create({
      duplex,
      role,
      sendKey: role === 'initiator' ? kI2R : kR2I,
      recvKey: role === 'initiator' ? kR2I : kI2R,
      peerNodeId: String(peer.nodeId),
      pairingId: result.pairingId,
      strategy: chosen,
      pendingFrames: queue, // passed by reference: frames can still arrive while the keys are imported
    });
    return { channel, peerNodeId: String(peer.nodeId), pairingId: result.pairingId, strategy: chosen };
  } catch (err) {
    return fail(err);
  }
}

function lengthPrefixed(frames: string[]): Uint8Array {
  return concat(
    ...frames.flatMap((f) => {
      const b = utf8(f);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, b.length);
      return [len, b];
    }),
  );
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    k,
    length * 8,
  );
  return new Uint8Array(bits);
}

