import path from 'node:path';
import { AdminHost } from './admin';
import { ControlApi } from './control-api';
import { loadExperimentConfig } from './config-file';
import { ParticipantHost } from './participant';
import { startServer } from './server';
import { StateFile } from './state';

export { AdminHost } from './admin';
export { ControlApi, type ControlBackend } from './control-api';
export { loadExperimentConfig } from './config-file';
export { ParticipantHost } from './participant';
export { isLoopback, startServer } from './server';
export { StateFile } from './state';

export const DEFAULT_PORTS = { participant: 4280, admin: 4290 } as const;

export interface HostOptions {
  role: 'participant' | 'admin';
  dataDir: string;
  /** 0 = pick a free port (tests). */
  port?: number;
  /** Participant: '0.0.0.0' so admin machines can reach /peer. Admin: loopback only. */
  bindAddress?: string;
  staticDir?: string | null;
  extraOrigins?: string[];
  log?: (msg: string) => void;
  onQuit?: () => void;
}

export interface RunningHost {
  role: 'participant' | 'admin';
  port: number;
  participant: ParticipantHost | null;
  admin: AdminHost | null;
  close(): Promise<void>;
}

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const log = opts.log ?? ((m: string) => console.log(`[${opts.role}] ${m}`));
  const dataDir = path.resolve(opts.dataDir);
  const state = new StateFile(dataDir, opts.role);

  if (opts.role === 'participant') {
    const { config, source } = loadExperimentConfig(dataDir);
    log(`Config: ${source}`);
    const participant = new ParticipantHost({ dataDir, state, config, log, onQuit: opts.onQuit });
    const api = new ControlApi(participant);
    const server = await startServer({
      port: opts.port ?? DEFAULT_PORTS.participant,
      bindAddress: opts.bindAddress ?? '0.0.0.0',
      staticDir: opts.staticDir ?? null,
      extraOrigins: opts.extraOrigins ?? [],
      onUi: (ws) => participant.handleUi(ws),
      onPeer: (ws, remote) => void participant.handlePeer(ws, remote),
      onApiHttp: (req, res) => void api.handleHttp(req, res),
      onApiWs: (ws) => api.handleWs(ws),
    });
    log(`Participant host ${state.state.hostId} on port ${server.port}; data in ${dataDir}`);
    return {
      role: 'participant',
      port: server.port,
      participant,
      admin: null,
      close: async () => {
        participant.close();
        await server.close();
      },
    };
  }

  const admin = new AdminHost({ dataDir, state, log });
  const api = new ControlApi(admin);
  const server = await startServer({
    port: opts.port ?? DEFAULT_PORTS.admin,
    bindAddress: opts.bindAddress ?? '127.0.0.1',
    staticDir: opts.staticDir ?? null,
    extraOrigins: opts.extraOrigins ?? [],
    onUi: (ws) => admin.handleUi(ws),
    onApiHttp: (req, res) => void api.handleHttp(req, res),
    onApiWs: (ws) => api.handleWs(ws),
  });
  log(`Admin host ${state.state.hostId} on port ${server.port}; data in ${dataDir}`);
  return {
    role: 'admin',
    port: server.port,
    participant: null,
    admin,
    close: async () => {
      admin.close();
      await server.close();
    },
  };
}
