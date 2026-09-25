# Architecture

GT Ball Drop is a dual-task psychology experiment: participants catch falling balls
(typically the primary task, a stand-in for driving) while doing a secondary task. This repo is a web port of the 2010–2017 C4-engine version
(`BallDropGame`) and its Java/Swing admin panel (`BallDropAdmin`).

## Principles

1. **Pure core, adapters at the edges.** The experiment logic has no I/O, rendering or
   clock of its own. It takes commands and elapsed time and emits domain events. So it is
   testable headlessly and reproducible from a seed.
2. **Local-first capture.** Every event is saved on the machine that produced it before it
   goes anywhere else. Replication to the host's files, an admin mirror or (later) a cloud
   API is the same mechanism: an outbox with per-target acknowledgements.
3. **Structured events are the source of truth.** The legacy `event_log.txt` is an
   *export* built from the event stream, so old analysis scripts keep working and nothing
   is modelled around a text format.
4. **Ports only where a second implementation is foreseeable.** Those are `EventSink`
   (outbox + replication target), `Transport` (`MessageDuplex`) and `PairingStrategy`. The
   renderer and input are simply kept outside the core, with no abstract interface.

## Packages

```
packages/
  protocol   config schema + defaults, domain events, event envelope, wire messages (zod)
  core       Experiment state machine, calibration staircase, lane selection, spring,
             geometry, seeded RNG, SessionRecorder (seq), legacy log exporter. No I/O.
  secure     MessageDuplex (transport port), PairingStrategy (pairing port), token-v1,
             handshake + key schedule, SecureChannel (AES-GCM). WebCrypto only.
  sinks      OutboxStore (memory, IndexedDB), Replicator, ReplicationTarget;
             node/SessionFiles (session dir on disk, idempotent, fsynced)
  host       Node host: static UI + /ui link + /peer link. ParticipantHost, AdminHost.
apps/
  game-web   Three.js renderer, DOM dialogs, keyboard input, HostLink, Capture
             (host | browser), browser-mode setup screen
  admin-web  Admin panel (browser)
  desktop    Electron shell: embeds the host, kiosk window, role = participant | admin
```

Dependency direction: `protocol` ← `core` ← `sinks` ← `host`; `secure` depends on nothing.
The apps sit on top. `core` and `secure` run unchanged in the browser and in Node.

## Runtime picture (LAN)

```
 participant machine                                   admin machine
┌──────────────────────────────────────────┐          ┌──────────────────────────────┐
│ Electron (kiosk)                         │          │ Electron / any browser       │
│  game page                               │          │  admin page                  │
│   Experiment ─events─▶ SessionRecorder    │          │   status, commands, feed     │
│        ▲                 │ (seq)         │          │        ▲   │                 │
│   input│                 ▼               │          │   /ui  │   ▼                 │
│        │        IndexedDB outbox         │          │  AdminHost                   │
│        │                 │ Replicator    │          │   mirror/<session>/          │
│        │     /ui (loopback, JSON)        │  /peer   │    events.jsonl              │
│  ParticipantHost ◀────────┘       ◀══════╪══════════╪═▶  event_log.txt             │
│   sessions/<session>/  (primary copy)    │ Secure-  │   clock offset (ping/pong)   │
│    events.jsonl  event_log.txt           │ Channel  │                              │
│    config.json   session.json            │          │                              │
└──────────────────────────────────────────┘          └──────────────────────────────┘
```

* **The core runs in the game page**, which owns the session: it creates the session id and
  assigns every event a gap-free `seq`. Host-side happenings the experiment should record
  (admin connected or lost, clock offset) are sent to the page and recorded there, so there
  is exactly one writer of the sequence.
* **The participant host is the primary durable copy.** It fsyncs each batch and then acks.
  The page's outbox drops events only after the ack.
* **The admin host mirrors.** It dials the participant host, syncs from its last stored
  seq, and acks each batch. After a disconnect it resumes where it left off. Mirrors have
  been verified byte-identical to the primary (see `packages/host/test`).
* **The admin never guesses state.** The participant streams `ExperimentStatus`, and the
  admin page offers only the command that makes sense for the current screen.

## Browser mode (no host)

The static build (`VITE_BROWSER=1`) swaps `hostCapture` for `browserCapture`, and
`config.json` for a setup screen validated by the same `ExperimentConfigSchema`. Events go
into an `IndexedDbOutboxStore` of their own as they happen. Nothing replicates them: at
the end the session is exported as a zip (`events.jsonl`, `event_log.txt` built by the
same legacy exporter, and `config.json` taken from the `session-started` event), and is
trimmed from the store only after the download. So the page needs no session metadata of
its own, and a crashed tab's session can still be exported on the next visit. The
experiment, recorder and renderer are the same code as with a host.

## Event model

```ts
interface EventEnvelope {
  schema: 1;
  sessionId: string;   // generated by the page that runs the core
  seq: number;         // gap-free per session: idempotency + resume key
  tWall: number;       // epoch ms, for cross-machine alignment
  event: DomainEvent;  // { type, tExp, tSys, ...payload }
}
```

* `tExp`: experiment time in ms. It **stops during pause screens**, like the C4 world
  clock. The legacy log's timestamps use it.
* `tSys`: ms since session start, running through pauses.
* `tWall`: wall clock, for lining events up with the other machine's second task. The admin
  host measures the clock offset every 10 s and it is logged as `clock-sync` events.

Anything that stores events deduplicates on `(sessionId, seq)`. Resending is always safe.

## Ports and their implementations

| Port | Today | Planned or possible |
|---|---|---|
| `OutboxStore` | `IndexedDbOutboxStore` (browser), `MemoryOutboxStore` | — |
| `ReplicationTarget` | participant host (via `HostLink`) | cloud ingest API (HTTPS, batch POST, idempotent on `(sessionId, seq)`) |
| `MessageDuplex` (transport) | LAN WebSocket, in-memory pair (tests) | relay WebSocket (both sides dial out) |
| `PairingStrategy` | `token-v1` (26-char, 128-bit code) | `pake-v1` (short word codes, SPAKE2/CPace), cloud accounts |

### Adding a cloud sink later

Write a `ReplicationTarget` that POSTs batches and acks the highest seq the server
reports. Add it to the `Replicator` target list in `hostCapture`
(`apps/game-web/src/capture.ts`). The outbox
then keeps events until *both* the local host and the cloud have them. For online studies
with no Electron and no host, the cloud target can be the only one. Nothing in `core`
changes.

### Adding a relay later

The relay is a stateless forwarder that pairs two sockets per channel. Give the
admin and participant hosts a `MessageDuplex` over a relay WebSocket instead of a direct
one. `handshake()` and `SecureChannel` are unchanged, and the relay only ever sees
ciphertext.

### Adding PAKE later

Implement `PairingStrategy` with id `pake-v1`, and list it first on both sides:
`strategies: [pake, token]`. The hello negotiates the best strategy both sides support,
so v1 clients keep working. A strategy only has to produce a shared `secret`. The key
schedule, key confirmation and channel are shared.

## Control API (other programs)

Both hosts serve `GET /api/status`, `POST /api/command` and `WS /api/events` on loopback
(`packages/host/src/control-api.ts`, documented for users in INSTRUCTIONS.md §3.2).
Each host implements `ControlBackend`:

* **The participant host** delivers a command to the game page, like a peer command.
* **The admin host** forwards it over the SecureChannel.

So a program on either machine drives the experiment without implementing pairing or
crypto. The experiment treats these exactly like admin-panel commands (`remote-command`
events, with `source` saying which sent them). A POST waits up to 2 s for that event to
report `accepted`.

## Security model (LAN)

* **`/ui`** (the page ↔ its own host): loopback only, plus an Origin allowlist. Otherwise
  any web page open in the machine's browser could drive the experiment.
* **`/api/*`** (the control API): loopback only. A request carrying any other browser
  Origin is refused, and `POST /api/command` requires `Content-Type: application/json`,
  which a web page can't send cross-origin without a CORS preflight that the host never
  answers. So other programs on the machine can use it, but web pages can't.
* **`/peer`** (host ↔ host): reachable from the LAN, but a peer must complete the handshake:
  * The pairing code is 128 bits and is never sent. Only an HMAC-derived id is.
  * Each connection gets fresh keys: HKDF over the secret, both nonces and the transcript hash.
  * Both sides confirm the keys, which catches a wrong code and any tampering with the hellos, including a downgrade.
  * After that the channel uses AES-256-GCM, with strict counters (no replay or reordering).
* **`host.json`** in the data dir holds the pairing secrets (file mode 0600). Keep the
  data dir private.
* Static UI files are served to loopback only.

## Timing

* The simulation runs in fixed 1 ms steps (the C4 clock's resolution), independent of
  frame rate.
* Before handling a key, the page advances the experiment to the key event's `timeStamp`,
  so moves land on their own millisecond, not on the next frame.
* `requestAnimationFrame` drives rendering. A 20 ms timer also advances time, in case
  rAF is throttled.
* Electron disables background throttling and blocks display sleep for the participant
  role.

## Running

```bash
npm install
npm test                    # unit + integration tests
npm run typecheck
npm run dev:participant     # host :4280 + game UI http://localhost:5173
npm run dev:admin           # host :4290 + admin UI http://localhost:5174
npm run desktop             # build the UIs and run the Electron app (participant, kiosk)
npm run desktop:admin       # the same, admin role
npm run convert-c4-config -- variables.cfg config.json   # one-time conversion of an old C4 config
```

Useful flags for the desktop app: `--data=DIR`, `--port=N`, `--windowed`.
Data goes to `<userData>/<role>/` by default. In dev it goes to `./data/<role>/`.

Experiment config: `<dataDir>/config.json`, created with the defaults on first run. The app
reads nothing else; old C4 configs go through the converter in `tools/` once.
