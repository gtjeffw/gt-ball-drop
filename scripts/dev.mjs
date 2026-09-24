// Dev runner: a host (via tsx) plus the matching Vite dev server, both in the foreground.
//   node scripts/dev.mjs participant   -> host :4280 + game UI  http://localhost:5173
//   node scripts/dev.mjs admin         -> host :4290 + admin UI http://localhost:5174
import { spawn } from 'node:child_process';

const role = process.argv[2] === 'admin' ? 'admin' : 'participant';
const hostPort = role === 'admin' ? 4290 : 4280;
const vitePort = role === 'admin' ? 5174 : 5173;
const app = role === 'admin' ? '@gtbd/admin-web' : '@gtbd/game-web';

const procs = [
  spawn(
    'npx',
    [
      'tsx', 'packages/host/src/cli.ts',
      '--role', role,
      '--port', String(hostPort),
      '--data', `./data/${role}`,
      '--allow-origin', `http://localhost:${vitePort}`,
      '--allow-origin', `http://127.0.0.1:${vitePort}`,
    ],
    { stdio: 'inherit' },
  ),
  spawn('npm', ['run', 'dev', '-w', app, '--', '--port', String(vitePort)], {
    stdio: 'inherit',
    env: { ...process.env, GTBD_HOST_PORT: String(hostPort) },
  }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
