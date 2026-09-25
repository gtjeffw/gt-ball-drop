# Deploying browser mode

Browser mode is a static build of the game page, for sessions with the experimenter in
the room ([INSTRUCTIONS.md](INSTRUCTIONS.md#browser-mode-experimenter-in-the-room)). It
has no server and uploads nothing: a setup screen replaces `config.json`, and each session
is offered as a .zip download at the end. The same site doubles as a public demo; link to
it with `?preset=quick` for a short session.

```bash
npm run dev:browser      # try it locally (Vite dev server)
npm run build:browser    # static files in apps/game-web/dist-browser/
```

Presets live in `apps/game-web/src/presets.ts`. URL parameters: `?preset=quick|calibration|study2017`,
`?nofullscreen`.

## Cloudflare Pages (builds on every push)

Create a Pages project connected to the Git repository, with:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm run build:browser` |
| Build output directory | `apps/game-web/dist-browser` |
| Root directory | *(repository root)* |
| Environment variable | `ELECTRON_SKIP_BINARY_DOWNLOAD` = `1` (the install otherwise downloads the ~100 MB Electron binary, which browser mode doesn't need) |

Pages runs `npm ci` itself before the build command, and reads the Node version from
`.nvmrc`.

Pages can only connect to repositories on **github.com** or **gitlab.com**, not to a
self-hosted GitHub such as github.gatech.edu. To deploy from a self-hosted repository,
build in its CI instead and upload with Wrangler (`npx wrangler pages deploy
apps/game-web/dist-browser --project-name=…`, with a Cloudflare API token as a CI secret).

Session data is kept in the browser's storage for the site's origin. Moving the site to a
new domain starts with empty storage, so download any stored sessions first.
