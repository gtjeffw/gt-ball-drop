# GT Ball Drop

A ball-catching task for dual-task user studies, originally developed for Dr. Bruce Walker's
[Sonification Lab](https://sonify.psych.gatech.edu) at the Georgia Institute of Technology.

Blue balls fall down seven lanes, and the participant moves a paddle left and right with
the keyboard to catch them. In a typical study, catching balls is the participant's
**primary task** while they also perform a **secondary task**, such as finding an item in
an auditory menu. Ball catching is a continuous visual-motor task that can stand in for an
activity like driving. That is especially true in **lane mode**, where each ball falls in
the same lane as the last one or next to it, so following them is like holding a lane.
Every catch, miss and paddle move is logged with its timing, which shows how much the
secondary task interferes with the primary one.

Before the study blocks, an optional **difficulty calibration** adjusts the ball speed and
the time between drops until the participant catches a target share of the balls. This
puts every participant at a comparable level of difficulty, and keeps the task hard enough
that divided attention shows up in the results rather than hitting a ceiling. The
secondary task's software can drive the session, starting and ending blocks, through a
local control API.

## History

Jeff Wilson wrote the original GT Ball Drop in 2010, in C++ on the Terathon C4 game
engine, with a Java admin panel. It was used in the lab's studies from 2010 to 2017. The
experiment software for the secondary task controlled it over a network socket, so both
programs' logs could be lined up precisely.

It served as the primary task in some of Wilson's doctoral research on auditory menus, supervised
by Bruce Walker: studies comparing *push* menus, which play items in sequence until the
user selects one, with *pull* menus, which the user steps through. Catch rates showed the
cost of each menu design to the primary task. For example, in one study they fell as menus
got longer, and fell less with push menus than with pull menus.

> Wilson, J. (2016). *Push and Pull Menus for Auditory Interfaces* (Doctoral dissertation).
> Georgia Institute of Technology. <https://hdl.handle.net/1853/56308>

The C4 engine is no longer available, so version 3 (2026) is a rewrite for the web. It
reproduces the original's behavior, timing, logs and look, and the original's
configuration files can be converted. [docs/FIDELITY.md](docs/FIDELITY.md) records what
matches, what was measured or approximated, and every deliberate change.

## This version

* **Game:** TypeScript + Three.js, with the experiment logic ported from the C++ into a
  pure, tested core.
* **Capture:** local-first. The page's IndexedDB outbox feeds the participant host, which
  keeps the primary copy on disk. The admin host keeps a mirror. Structured `events.jsonl`
  plus the original `event_log.txt` format, so existing analysis scripts keep working.
* **Admin:** a web panel that pairs with the participant machine over the LAN, using an
  encrypted, mutually authenticated channel.
* **Control API:** another program on the participant machine (such as the secondary
  task's software) can start and end blocks and follow events live.
* **Deployment:** an Electron app (participant = kiosk, admin = window), or run the host
  and use any Chromium browser. Or **browser mode**: a static website with a setup
  screen, for sessions with the experimenter in the room, and a .zip download at the end.

```bash
npm install
npm test
npm run dev:participant   # http://localhost:5173
npm run dev:admin         # http://localhost:5174, then enter 127.0.0.1:4280 and the pairing code
npm run desktop           # the desktop app (participant); npm run desktop:admin for the admin
```

**Running experiments:** see [docs/INSTRUCTIONS.md](docs/INSTRUCTIONS.md) (setup, settings,
data files, the control API). **Browser mode** (static site for supervised sessions, e.g.
on Cloudflare Pages): see [docs/DEPLOY.md](docs/DEPLOY.md). **Design and extension
points** (cloud sink, relay, PAKE): see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Node 22 (`.nvmrc`).

## Author

Jeff Wilson, PhD, Georgia Institute of Technology (<jeff.wilson@gatech.edu>).

To cite GT Ball Drop, use the citation on the repository page, or see
[CITATION.cff](CITATION.cff).

## License

[MIT](LICENSE). Copyright (c) 2010-2026 Jeff Wilson, PhD, Georgia Institute of Technology.

Every build includes `LICENSE` and `THIRD_PARTY_LICENSES.txt`, the licences of the npm
packages bundled into it. The desktop build also includes Electron's and Chromium's
licences (`LICENSE.electron.txt`, `LICENSES.chromium.html`).
