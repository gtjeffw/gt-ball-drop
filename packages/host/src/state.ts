import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, toHex } from '@gtbd/secure';

/**
 * State the host keeps between runs, in <dataDir>/host.json (mode 0600). It holds pairing
 * secrets, so it is as sensitive as a password file: keep the data dir private.
 */
export interface StoredPairing {
  pairingId: string;
  /** base32 pairing code (the shared secret) */
  code: string;
  /** Admin side: the participant address this code is for. Participant side: null. */
  address: string | null;
  peerNodeId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface HostState {
  hostId: string;
  pairings: StoredPairing[];
  /** Participant side: a code shown to the experimenter and not yet used. */
  pendingCode: string | null;
}

export class StateFile {
  readonly state: HostState;
  private readonly file: string;

  constructor(dataDir: string, role: 'participant' | 'admin') {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'host.json');
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as HostState;
    } else {
      this.state = { hostId: `${role === 'participant' ? 'p' : 'a'}-${toHex(randomBytes(6))}`, pairings: [], pendingCode: null };
      this.save();
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
