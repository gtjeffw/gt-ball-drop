import path from 'node:path';
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import { DEFAULT_PORTS, startHost, type RunningHost } from '@gtbd/host';

/**
 * Desktop shell: one app with two roles.
 *
 *   participant: runs the host in-process and shows the game in a kiosk window
 *   admin:       runs the admin host and shows the admin panel in a normal window
 *
 *   electron . --role=participant|admin [--data=DIR] [--port=N] [--windowed]
 *
 * Electron pins the Chromium version, so rendering and input timing are the same on
 * every lab machine and a browser auto-update can't change them mid-study.
 */
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name: string) => process.argv.includes(`--${name}`);

const role = (arg('role') ?? process.env.GTBD_ROLE) === 'admin' ? 'admin' : 'participant';
const windowed = flag('windowed');
const appRoot = path.resolve(__dirname, '..', '..'); // apps/
const staticDir = path.join(appRoot, role === 'admin' ? 'admin-web' : 'game-web', 'dist');

// Keep the game's timers and rendering at full rate even if the window is covered.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

let host: RunningHost | null = null;

async function main(): Promise<void> {
  await app.whenReady();
  host = await startHost({
    role,
    dataDir: arg('data') ?? path.join(app.getPath('userData'), role),
    port: arg('port') ? Number(arg('port')) : DEFAULT_PORTS[role],
    staticDir,
    onQuit: () => app.quit(),
  });

  const participant = role === 'participant';
  const win = new BrowserWindow({
    width: participant ? 1024 : 1100,
    height: participant ? 768 : 760,
    kiosk: participant && !windowed,
    autoHideMenuBar: true,
    backgroundColor: participant ? '#000000' : '#f2f4f7',
    title: participant ? 'GT Ball Drop' : 'GT Ball Drop Admin',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // Only our own host's pages, no pop-ups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(`http://127.0.0.1:${host!.port}/`)) ev.preventDefault();
  });
  if (participant) powerSaveBlocker.start('prevent-display-sleep');
  await win.loadURL(`http://127.0.0.1:${host.port}/${participant ? '?nofullscreen' : ''}`);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  void host?.close();
});

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
