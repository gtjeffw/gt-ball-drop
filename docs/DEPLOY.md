# Deploying the web demo

The demo is a static build of the game page. It runs entirely in the browser, has no
server, and uploads nothing. Visitors pick a settings preset and a look, play a session,
and can download its data at the end (`events.jsonl`, `event_log.txt`, `config.json`).
There is no remote control or admin pairing in the demo.

```bash
npm run dev:demo      # try it locally (Vite dev server)
npm run build:demo    # static files in apps/game-web/dist-demo/
```

Presets live in `apps/game-web/src/demo.ts`. URL parameters: `?preset=quick|calibration|study2017`,
`?world=classic|clean`, `?shading=0..1`, `?nofullscreen`.

## Cloudflare Pages (builds on every push)

Create a Pages project connected to the Git repository, with:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm run build:demo` |
| Build output directory | `apps/game-web/dist-demo` |
| Root directory | *(repository root)* |
| Environment variable | `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (the install otherwise downloads the ~100 MB Electron binary, which the demo doesn't need) |

Pages runs `npm ci` itself before the build command, and reads the Node version from
`.nvmrc`.

Pages can only connect to repositories on **github.com** or **gitlab.com**, not to a
self-hosted GitHub such as github.gatech.edu. To deploy from a self-hosted repository,
build in its CI instead and upload with Wrangler (`npx wrangler pages deploy
apps/game-web/dist-demo --project-name=…`, with a Cloudflare API token as a CI secret).

## Before making anything public

`apps/game-web/public/c4/` contains textures extracted from the C4 engine's stock content
(the sky, noise, wall and yellow-flame textures). These are included in the demo build and
in the repository history. See `apps/game-web/public/c4/README.md`: check that the lab's
C4 license allows publishing them before deploying the demo publicly or making the
repository public.
