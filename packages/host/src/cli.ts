import { parseArgs } from 'node:util';
import { DEFAULT_PORTS, startHost } from './index';

const { values } = parseArgs({
  options: {
    role: { type: 'string', default: 'participant' },
    port: { type: 'string' },
    data: { type: 'string' },
    static: { type: 'string' },
    bind: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
  },
});

const role = values.role === 'admin' ? 'admin' : 'participant';
const host = await startHost({
  role,
  dataDir: values.data ?? `./data/${role}`,
  port: values.port ? Number(values.port) : DEFAULT_PORTS[role],
  bindAddress: values.bind,
  staticDir: values.static ?? null,
  extraOrigins: values['allow-origin'] ?? [],
  onQuit: () => console.log(`[${role}] quit requested by the game page (only the desktop app exits)`),
});

const shutdown = async () => {
  await host.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
