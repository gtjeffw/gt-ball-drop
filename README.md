# GT Ball Drop

A web port of the GT Ball Drop dual-task experiment (Georgia Tech Sonification Lab),
replacing the C4-engine game and the Java admin panel.

* **Game:** TypeScript + Three.js, with the experiment logic ported from the C++ into a
  pure, tested core.
* **Capture:** local-first. The page's IndexedDB outbox feeds the participant host, which
  keeps the primary copy on disk. The admin host keeps a mirror. Structured `events.jsonl`
  plus the legacy `event_log.txt`.
* **Admin:** a web panel that pairs with the participant machine over the LAN, using an
  encrypted, mutually authenticated channel.
* **Deployment:** an Electron app (participant = kiosk, admin = window), or run the host
  and use any Chromium browser.

```bash
npm install
npm test
npm run dev:participant   # http://localhost:5173
npm run dev:admin         # http://localhost:5174, then enter 127.0.0.1:4280 and the pairing code
npm run desktop           # the desktop app (participant); npm run desktop:admin for the admin
```

**Running experiments:** see [docs/INSTRUCTIONS.md](docs/INSTRUCTIONS.md) (setup, settings, data files).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and extension points
(cloud sink, relay, PAKE). See [docs/FIDELITY.md](docs/FIDELITY.md) for what matches the
original, what was measured or approximated, and every deliberate behavior change.

Node 22 (`.nvmrc`).
