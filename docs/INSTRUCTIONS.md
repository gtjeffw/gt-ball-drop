# GT Ball Drop: Experimenter's Guide

GT Ball Drop is a ball-catching task for dual-task experiments. Blue balls fall down seven
lanes, and the participant moves a red paddle left and right with the keyboard to catch
them. A ball that is missed drops into the fire pit below its lane. The task can calibrate
its difficulty to each participant, runs a configurable number of blocks, and logs every
event.

It is typically the **primary** task: a continuous visual-motor task that stands in for
driving, while the participant also performs a secondary task such as choosing items from
an auditory menu. The session can be run by the participant, by an experimenter from a
second computer, or by the program that runs the secondary task.

(This is a new implementation of the earlier GT Ball Drop, built on the C4 engine. Old C4
configuration files can be [converted](#converting-an-old-configuration).)

---

## 1. Running it

### Desktop app (recommended for lab machines)

One app, two roles. The **participant** role runs full screen (kiosk). The **admin** role is
a normal window, and you only need it if someone controls the session from a second
computer.

```bash
npm install
npm run desktop          # participant machine
npm run desktop:admin    # admin machine (optional)
```

Options go after `--`, e.g. `npm run desktop -- --windowed`:

| Option | Meaning |
|---|---|
| `--data=DIR` | data folder (default: see [Where files are](#6-where-files-are)) |
| `--port=N` | port (default 4280 participant, 4290 admin) |
| `--windowed` | participant role in a normal window instead of kiosk, for testing |

To leave kiosk mode, quit from the start screen (**Esc** or **Quit**), or use the OS quit
shortcut (⌘Q on macOS, Alt+F4 on Windows).

### Browser mode (experimenter in the room)

A static website version with nothing to install: open the lab's Ball Drop site (see
[DEPLOY.md](DEPLOY.md)) in Chrome, Edge or Firefox. It is meant for supervised sessions,
where the experimenter sets up the computer and then hands it to the participant.

1. **Setup screen** (experimenter). Every setting from [`config.json`](#4-configuration),
   grouped and checked as you type. Start from a preset (presets set the session and
   timing, and leave the look alone), or **Load config.json…** to use a lab config file.
   **Save config.json** writes the current settings to a file. The browser remembers the
   last settings used, and **Reset to defaults** goes back to the lab defaults. A joystick
   or steering wheel is set up in the **Controller** section (see
   [Joysticks and steering wheels](#joysticks-and-steering-wheels)).
2. **Continue to participant screen**, then hand over. The participant screen is the usual
   start screen. **Settings** (or **Esc**) goes back to the setup screen.
3. At the end, after *"Experiment complete!"* and **Quit**: **Download session data
   (.zip)**. The zip holds the session folder: `events.jsonl`, `event_log.txt` and
   `config.json` (see [What gets recorded](#5-what-gets-recorded)). **Results** shows the
   block scores, for the experimenter. **Set up another session** returns to the setup
   screen.

Events are saved in the browser's storage as they happen, and are deleted only after you
have downloaded them and moved on. If the tab is closed or crashes first, the next visit
lists the session with **Download** and **Discard** buttons.

Limits compared with the desktop app:

* The data exists only in that browser until it is downloaded. A private/incognito window,
  or clearing the browser's site data, deletes it. The setup screen says whether the
  browser agreed to keep the site's storage persistent. If it didn't (Chrome decides by how
  much the site is used; bookmarking or installing it helps), the browser may also clear
  it when the disk runs low.
* No kiosk: the page asks for full screen on **Start**, but the participant can leave it
  (**Esc**) and reach the rest of the computer. Supervise.
* No remote control, admin panel or control API (`remoteControl` is always off).
* `?preset=quick`, `?preset=calibration` or `?preset=study2017` in the URL opens the setup
  screen with that preset.

To run browser mode from a checkout: `npm run dev:browser` (then the URL it prints).

### In a browser (development)

```bash
npm run dev:participant    # then open http://localhost:5173
npm run dev:admin          # then open http://localhost:5174
```

URL options for the game page, for testing and comparison only (they are **not** recorded
in the session logs):

| Parameter | Effect |
|---|---|
| `?nofullscreen` | don't switch to full screen on Start |
| `?world=classic` / `?world=clean` | override `appearance.world` |
| `?shading=0` … `1` | override `appearance.modelShading` |

---

## 2. A session, step by step

1. **Start screen.** Type the participant ID (pre-filled from `defaultParticipantId`) and
   press **Enter** or click **Start**. The **Experimenter** panel at the bottom shows
   whether the local host is connected (so logs go to disk), the pairing code for an admin
   machine, and whether remote control is on.
2. **Calibration** (if `calibration.enabled`): an intro screen, then the optional practice
   block, then scored calibration blocks separated by short breaks, which continue by
   themselves after 2 s. It ends with *"Difficulty Calibration is complete"*. See
   [Calibration](#calibration).
3. **Experiment intro:** *"Experiment now begins…"*
4. **Blocks:** `numBlocks` blocks of `numTrials` balls, with a break screen between blocks.
5. **Complete:** *"Experiment complete! Notify experiment administrator."* Press **Quit**
   (or **Esc**) once the data has been saved.

### Keys

| Key | When | Does |
|---|---|---|
| **←** / **A** | playing | move the paddle one lane left |
| **→** / **D** | playing | move the paddle one lane right |
| **Enter** | a screen with a Continue button | continue |
| **Esc** | a screen with a Quit button | quit (the session is logged as aborted) |
| **9** | a screen *without* buttons (remote control) | experimenter override: continue |
| **0** | a screen *without* buttons | experimenter override: quit |

Each key press moves exactly one lane. Holding a key does not repeat. The paddle eases into
the new lane with a damped spring: about 90% of the way in 0.2 s, settled in about 0.5 s.

While a screen is showing, the game is paused. Experiment time stops, balls freeze, and
paddle moves are ignored.

### Joysticks and steering wheels

A USB joystick, gamepad or simple steering wheel can move the paddle with one of its axes.
The keyboard keeps working alongside it, except in position mode (below).

**Setting it up (experimenter).** In browser mode, use the **Controller** section of the
setup screen. In the desktop app, and on any start screen, open **Experimenter**. Then:

1. **Device:** click **Connect a controller…** and pick it. Chrome and Edge show their own
   device chooser, and the desktop app shows a dialog if more than one controller is
   plugged in. A device listed as *Gamepad API, polled* appears after you press one of its
   buttons.
2. **Axis:** click **Detect** and turn the wheel or push the stick. Or pick the axis from
   the list (on a wheel it is usually *X* or *Steering*). Tick **Invert** if right moves
   the paddle left.
3. **Range:** the device's physical extents, by default the limits it reports itself. Only
   if the stick or wheel doesn't reach those (the meter stops short of the ends at full
   throw) or doesn't centre on them, click **Calibrate…**, move it as far as it goes to
   both sides, and click **Done**. **Use reported** undoes it. How much of the range a
   participant has to use is the experiment's reach (below), not this.

The meter under the settings shows the axis live, with the lanes (position mode) or push
bands (step mode) it would trigger. The computer remembers the device, axis, invert and
range, and reconnects to the device next time. Every session records them (the
`controller` event).

**How the axis moves the paddle** (`controller.mapping` in [Configuration](#4-configuration)).
In browser mode these settings are in the setup screen's **Controller** section. The desktop
app has no setup screen, so they are in its `config.json`. Either way, the **Mode** line at
the top of the Experimenter panel says which mode is in use.

* **Steps** (`"step"`, the default): like the arrow keys. Pushing past
  `controller.stepThreshold` of full travel moves one lane; the axis has to come back
  inside `controller.stepRelease` before the next push. Holding doesn't repeat.
* **Position** (`"position"`): the axis position sets the paddle's. Full left is the
  leftmost lane, the centre is the middle lane, and full right is the rightmost lane. How
  the paddle gets there is set by `controller.positionMotion`:
  * **Continuously** (`"continuous"`, the default): the paddle follows the axis exactly,
    with no spring. It can stop between lanes, and a ball is caught only when the
    paddle's centre is within 0.75 of the ball's (lanes are 2 apart), so this asks for
    more precision than the keys. The log records a paddle move each time the paddle
    passes the midpoint to another lane by a tenth of the spacing.
  * **In lanes** (`"lanes"`): the travel is split into seven equal zones, and the paddle
    springs to the lane the axis points at, one lane at a time, like a series of key
    presses. It changes lane only once the axis is `controller.positionHysteresis` of a
    zone past the edge, so a hand resting on a boundary doesn't make it jitter.

  `controller.positionReach` sets how much of the axis's travel spans the lanes. At `1`
  the full throw does. At `0.7`, 70% of the way to either side already reaches the outer
  lane, and anything beyond keeps the paddle there, for participants who find the full
  throw hard to reach, or on a wheel that turns 900°. Unlike the device's range, which is
  calibrated per computer, this is part of the config: the same on every machine, and
  recorded with each session.

  At the start of each block, after the paddle is reset to the middle, it goes straight to
  where the controller points. The arrow keys don't move the paddle while a controller is
  connected in this mode. A thumbstick springs back to the centre, so in this mode letting
  go of it brings the paddle back to the middle.

**Timing.** Chrome, Edge and the desktop app read the controller through **WebHID**: every
report the device sends (often 125–1000 a second) arrives as its own event, and each
move is applied at the time the page received that report, as with key presses. Other
browsers, and devices WebHID can't see, fall back
to the **Gamepad API**, which the page has to poll. It does that every 4 ms, so moves are
timed only to within about 4–16 ms and a very quick flick between two polls is missed. The
setup screen warns when this fallback is in use, and the session's `controller` event says
which one was used (`api`). Report timestamps are taken when the page receives each
report, so a page busy drawing can delay them slightly. The meter shows the report rate.

---

## 3. Remote control: an experimenter or another program

With `remoteControl.enabled`, the break screens (calibration intro, experiment intro,
between blocks) have no buttons and say *"See other screen for signal to start"*. They wait
for a remote **block-start** instead of the participant. Remote control can also end a
block or the whole experiment early:

| Command | Effect |
|---|---|
| `block-start` | dismiss the current break screen: start calibration, continue after it, start the next block |
| `block-end` | end the block that is running (ignored if none is) |
| `quit` | end the current block and the experiment |

Commands can come from **the admin panel** (a person on a second computer, [3.1](#31-the-admin-panel)),
or from **another program** through the **control API** ([3.2](#32-the-control-api)), e.g. the
experiment software running the secondary task. Every command is logged with where it came from.

Two screens don't wait: calibration breaks continue by themselves after 2 s, and the
*"Calibration complete"* screen can also be continued by the participant. The hidden **9**
key always works as an experimenter override.

Related settings: `remoteControl.infiniteTrials` (blocks only end on `block-end`) and
`remoteControl.infiniteBlocks` (the experiment only ends on `quit`).

### 3.1 The admin panel

A second computer that shows the participant's live status, sends commands, and keeps a
mirror copy of the data.

**Pairing (once per pair of computers):**

1. On the participant machine, start the app. Its start screen shows a **pairing code**
   under *Experimenter* (26 characters, e.g. `RG77-TAWY-3DZX-…`).
2. On the admin machine, open the admin panel and enter:
   * **Address:** the participant machine's IP address and port, e.g. `192.168.1.20:4280`
   * **Pairing code:** the code from step 1 (case, spaces and dashes don't matter)
3. Click **Connect**. From then on, both machines remember each other. Leave the code
   blank next time. To pair a further admin machine, click **Pair another admin** on the
   participant's start screen to get a new code.

The participant machine must accept incoming connections on port **4280** (allow it in its
firewall). The connection is encrypted and authenticated with the pairing code, so other
machines on the network can't read or control the experiment.

During the session, the panel shows the current screen, block, counts and difficulty, and
offers the command that fits: **Continue** / **Start block** on a break screen, **End
block** while a block runs, and **Quit experiment** (which asks to confirm). If the link
drops, the admin reconnects automatically and catches up on the data it missed. The
participant machine's copy is always the primary one.

### 3.2 The control API

Any program can drive the experiment over HTTP, in any language, with no pairing or
encryption to implement. The API is served by the app on **the program's own machine**:

* **Program on the participant machine:** `http://127.0.0.1:4280`
* **Program on the admin machine:** `http://127.0.0.1:4290`. The admin app must be running
  and connected to the participant. It forwards commands over the encrypted link.

The API only accepts connections from the same machine.

| Request | Response |
|---|---|
| `GET /api/status` | `{"connected": true, "status": {…}}`. `status` is `null` until a session has started. |
| `POST /api/command` with body `{"command": "block-start"}` and header `Content-Type: application/json` | `{"sent": true, "accepted": true}`. `accepted` is `false` if the experiment ignored the command (e.g. remote control is off, or `block-end` with no block running), and `null` if no confirmation arrived within 2 s. HTTP 409 if nothing can receive it (the game isn't open, or the admin isn't connected). |
| WebSocket `/api/events` | streams `{"t": "status", "status": {…}}` (about 4 per second) and `{"t": "event", "envelope": {…}}` for every event as it's recorded (the same records as `events.jsonl`, [section 5](#5-what-gets-recorded)). Send `{"t": "cmd", "command": "…"}` to issue a command. |

Useful fields of `status`:

| Field | Values |
|---|---|
| `phase` | `not-started`, `running`, `paused` (a screen is up), `ended` |
| `screen` | `null` while playing, else `{"id": …, "interactive": …}` with `id` one of `calibration-intro`, `calibration-break`, `calibration-complete`, `block-intro`, `block-break`, `complete` |
| `calibrating`, `calibBlock` | whether calibration is running, and its block (−1 = practice) |
| `block`, `numBlocks`, `numTrials` | experiment progress (`block` counts from 0) |
| `counts` | `{created, caught, missed, …}` for the current block |
| `difficulty` | `{ballSpeed, spawnTimeMs, laneStayChance}` currently in use |
| `participantId`, `sessionId`, `remoteControlled`, `tExp` | |

**A driver script**, the typical sequence: calibration, then the blocks, each started by the
secondary task's software. Python, standard library only:

```python
import json, time, urllib.request

BASE = "http://127.0.0.1:4280"   # 4290 when running on the admin machine

def status():
    return json.load(urllib.request.urlopen(BASE + "/api/status"))["status"]

def command(name):
    req = urllib.request.Request(BASE + "/api/command", method="POST",
                                 data=json.dumps({"command": name}).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

def screen():
    s = status()
    return s["screen"]["id"] if s and s["screen"] else None

def wait_for(screen_id):
    while screen() != screen_id:
        time.sleep(0.05)

def continue_from(screen_id):
    """Wait for a screen, dismiss it, and wait until it is really gone."""
    wait_for(screen_id)
    command("block-start")
    while screen() == screen_id:
        time.sleep(0.05)

continue_from("calibration-intro")          # start calibration
continue_from("calibration-complete")
for block in range(3):                      # numBlocks
    # ... prepare the secondary task for this block ...
    continue_from("block-intro" if block == 0 else "block-break")   # start the block
    # the block ends by itself after numTrials balls, or: command("block-end")
wait_for("complete")
```

The same from the command line, or from C#:

```bash
curl -s http://127.0.0.1:4280/api/status
```

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"command":"block-start"}' http://127.0.0.1:4280/api/command
```

```csharp
using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:4280") };
var body = new StringContent("{\"command\":\"block-start\"}", Encoding.UTF8, "application/json");
var reply = await (await http.PostAsync("/api/command", body)).Content.ReadAsStringAsync();
```

To line up the two tasks' timing afterwards, record wall-clock time in the other task's software.
Every Ball Drop event has `tWall` (epoch ms, [section 5](#5-what-gets-recorded)).

---

## 4. Configuration

The participant machine reads `config.json` from its data folder. The file is created with
the defaults on first run. Edit it while the app is closed. The exact config used is saved
into every session's folder, so each data set records how it was produced.

| Setting | Default | Meaning |
|---|---|---|
| `defaultParticipantId` | `GEORGEPBURDELL000` | pre-fills the start screen |
| `numBlocks` | `3` | experiment blocks |
| `numTrials` | `200` | balls per block. A block ends when this many balls have been **resolved** (caught + missed) |
| `onlyCreateNumTrialsBalls` | `true` | `true`: drop exactly `numTrials` balls per block. `false`: keep dropping until the block ends; balls still falling then are discarded |
| `ballSpawnTimeMs` | `400` | ms between drops |
| `ballSpeed` | `0.01` | fall speed in world units per ms (see [Speed and timing](#speed-and-timing)) |
| `dropMode` | `"lane"` | `"random"`, `"lane"` or `"neighborhood"` (see [Drop modes](#drop-modes)) |
| `laneNeighborhoodSize` | `2` | furthest jump in neighborhood mode (≥ 1) |
| `laneChangeStayChance` | `0` | percent chance (0–100) that the next ball drops in the same lane |
| `seed` | *(random)* | fixes the random sequence of drop lanes. The seed actually used is always logged |
| `calibration.enabled` | `false` | run calibration first |
| `calibration.numTrials` | `100` | balls per calibration block |
| `calibration.startWithPractice` | `true` | begin with one unscored practice block |
| `calibration.targetAvg` | `0.85` | target catch rate |
| `calibration.targetAvgErr` | `0.05` | tolerance: 0.80–0.90 counts as on target |
| `calibration.spawnTimeIncrMs` | `200` | first step size for the drop interval |
| `calibration.spawnTimeMinMs` | `100` | shortest drop interval allowed |
| `calibration.speedIncr` | `0.003` | first step size for ball speed |
| `calibration.speedMin` | `0.001` | slowest speed allowed |
| `calibration.maxRefinements` | `5` | direction changes allowed before calibration stops anyway |
| `calibration.autoContinueMs` | `2000` | calibration breaks continue by themselves after this; `0` = wait |
| `remoteControl.enabled` | `false` | break screens wait for the admin panel or a program ([section 3](#3-remote-control-an-experimenter-or-another-program)) |
| `remoteControl.infiniteTrials` | `false` | blocks end only on `block-end` (`numTrials` ignored) |
| `remoteControl.infiniteBlocks` | `false` | the experiment ends only on `quit` (`numBlocks` ignored) |
| `controller.mapping` | `"step"` | how a joystick or wheel axis moves the paddle: `"step"` (one lane per push) or `"position"` (the angle picks the lane). See [Joysticks and steering wheels](#joysticks-and-steering-wheels) |
| `controller.stepThreshold` | `0.5` | step mode: fraction of full travel that counts as a push |
| `controller.stepRelease` | `0.3` | step mode: back inside this fraction re-arms the next push (less than `stepThreshold`) |
| `controller.positionMotion` | `"continuous"` | position mode: `"continuous"` (the paddle follows the axis exactly, no spring) or `"lanes"` (it springs to the lane the axis points at) |
| `controller.positionReach` | `1` | position mode: fraction of full travel (0.2–1) that reaches the outer lanes; beyond it the paddle stays at the edge |
| `controller.positionHysteresis` | `0.2` | position mode in lanes: how far into the next lane's zone (fraction of a zone, 0–0.5) the axis must go before the paddle moves |
| `appearance.world` | `"classic"` | `"classic"`: cloudy sky and yellow flames. `"clean"`: pale-yellow background and red flames. Visual only |
| `appearance.flameHeightScale` | `0.5` | fire-pit flame height (1 = full height, which rises above the paddle) |
| `appearance.flameOpacity` | `0.7` | fire-pit flame brightness (0–1) |
| `appearance.modelShading` | `1` | 0 = flat, high-contrast ball and paddle; 1 = fully shaded |

### Speed and timing

The lanes are 2 units apart, and a ball falls about 9.8 units from where it appears to the
paddle. So:

**fall time to the paddle ≈ 9.8 / `ballSpeed` ms**

| `ballSpeed` | Fall time |
|---|---|
| 0.001 | ≈ 9.8 s (very easy) |
| 0.004 | ≈ 2.4 s |
| 0.01 | ≈ 0.98 s (the default) |

With the defaults (a ball every 400 ms, a 0.98 s fall), two or three balls are in the air
at once. With 750 ms and a 9.8 s fall, about 13 are.

### Drop modes

Each time a ball is due, the game first picks its lane:

* **random:** any of the 7 lanes, with equal chance. `laneChangeStayChance` is ignored.
* **lane:** stay in the current lane with probability `laneChangeStayChance`. Otherwise
  move one lane left or right (50/50). At an edge the move is always inward. Each ball is
  at most one lane from the last, so the paddle follows a drifting path: the lane-holding
  pattern that makes the task a stand-in for keeping a car in its lane.
* **neighborhood:** stay with probability `laneChangeStayChance`. Otherwise jump to one of
  the other lanes within `laneNeighborhoodSize`, with equal chance. With size 2 from
  lane 3, the candidates are 1, 2, 4 and 5 (plus 3 by staying). From lane 0 they are 1
  and 2 (plus 0).

To give every lane in the neighborhood (including the current one) the same chance, set
`laneChangeStayChance` to **100 / (2 × `laneNeighborhoodSize` + 1)**, e.g. 20 for size 2.
This is exact away from the edges. Near an edge there are fewer lanes to jump to, so each
of them becomes more likely, while the chance of staying stays the same. Set it to 0 to
always change lanes.

### Calibration

Calibration adjusts the drop interval and speed until the participant catches about
`targetAvg` of the balls:

1. The optional practice block is played but not scored.
2. After each scored calibration block, the catch rate (caught ÷ (caught + missed)) is
   compared with the target band:
   * **above** (too easy): the drop interval shrinks by the current step, and speed grows by its step;
   * **below** (too hard): the reverse;
   * **inside:** calibration ends.
3. Each time the direction reverses (easier ↔ harder), both step sizes are halved. After
   more than `maxRefinements` reversals, calibration ends anyway.
4. Limits: the drop interval never goes below `spawnTimeMinMs`, and speed never below
   `speedMin`.

The final interval and speed carry over into the experiment blocks and are logged as
`CALIB_RESULTS`. The drop mode and stay chance are not calibrated.

### Example configs

[`examples/`](examples/) has ready-made configs. Copy one to the data folder as
`config.json`.

### Converting an old configuration

To reuse the settings from an old C4-version `variables.cfg`, convert it once:

```bash
npm run convert-c4-config -- path/to/variables.cfg path/to/config.json
```

Settings the old file doesn't mention get the values the old version used for them, so
the result runs what the old setup ran. Then use it like any other `config.json`.

---

## 5. What gets recorded

Each session gets its own folder, named by start time and participant ID, for example
`2026-09-24_13-22-17_P001/`:

| File | Contents |
|---|---|
| `event_log.txt` | a compact comma-separated log of blocks, calibration, catches, misses and paddle moves (below) |
| `events.jsonl` | every event, one JSON object per line: the complete record (lane of every ball, every key press, screens, remote commands, clock sync) |
| `config.json` | the exact configuration used |
| `session.json` | session id, participant id, start time, app version, and any gaps in the record |

Data is saved as it happens, not at the end. Each batch is written to disk and flushed
before it counts as saved, so a crash loses at most the last fraction of a second. If the
page loses its connection to the local host, events are held in the browser and delivered
when it reconnects.

### `event_log.txt`

Every line is `seconds,TOKEN[,values…]`. **Seconds are experiment time, which stops during
screens and breaks.** Lines ending in `_DESCRIPT` name the columns of the line that
follows.

| Line | Meaning |
|---|---|
| `DATE,MM/DD/YYYY` · `TIME,HH:MM:SS` | when the session started |
| `GTBALLDROP_VERSION,v` · `EXPERIMENT_BEGIN` · `PARTICIPANT_ID,id` | session header |
| `BEGIN_CALIB` / `END_CALIB` | calibration starts / ends |
| `BEGIN_CALIB_BLOCK,n` | calibration block n (−1 = practice) |
| `CALIB_CONFIG,speed,spawnMs,stayChance` | the difficulty for that block |
| `END_CALIB_BLOCK,n` · `CALIB_BLOCK_RESULTS,n,missed,caught,dropped,adjustDir,flipCount` | result of a calibration block. `adjustDir` +1 = next block harder, −1 = easier |
| `CALIB_RESULTS,speed,spawnMs,stayChance` | the calibrated difficulty used from here on |
| `BEGIN_BLOCK,n` / `END_BLOCK,n` | experiment block n (from 0) |
| `BLOCK_RESULTS,n,missed,caught,dropped` | result of block n |
| `BALL_CAUGHT,k` / `BALL_MISSED,k` | the k-th catch / miss in the current block |
| `BALL_CATCHER_LEFT,c` / `BALL_CATCHER_RIGHT,c` | the paddle moved. c is the column: +3 = far left, 0 = middle, −3 = far right |
| `NETWORK_MASTER_SOCKET_CONNECTED` / `NETWORK_ERR_MASTER_SOCKET_LOST` | an admin machine connected / disconnected |
| `EXPERIMENT_END` | the experiment finished normally |

### `events.jsonl`

Each line is `{"schema":1,"sessionId":…,"seq":n,"tWall":epochMs,"event":{…}}`. `seq`
counts up from 0 with no gaps. `event.type` is one of:
* `session-started` (full config, random seed)
* `calibration-*`, `block-started`/`block-ended`
* `ball-spawned` (lane, speed), `ball-caught`/`ball-missed` (lane, paddle x; misses also give the paddle's lane), `ball-removed`
* `catcher-moved` (every press, including presses at an edge; `input` is `keyboard` or
  `controller`. With continuous control, one per lane the paddle passes into)
* `controller` (a joystick or wheel in use at the start, connected or disconnected: `api`
  `webhid` or `gamepad`, name, USB vendor and product IDs, axis, invert, range)
* `controller-axis` (the axis moved: `value` −1 to 1 after range and invert, and `raw` as
  the device reported it; changes under 0.005 aren't logged)
* `screen-shown`/`screen-dismissed` (and who dismissed it)
* `remote-command` (command, accepted, and its `source`: `admin-panel@…` or `control-api@…`)
* `admin-link`, `clock-sync` (the offset to an admin machine's clock)
* `experiment-ended`, `experiment-aborted`

Every event has `tExp` (experiment time, ms) and `tSys` (ms since the session started,
including pauses). `tWall` lets you line events up with other recordings. With an admin
machine, the `clock-sync` offsets relate the two machines' clocks.

---

## 6. Where files are

| | Participant machine | Admin machine |
|---|---|---|
| **macOS** | `~/Library/Application Support/GT Ball Drop/participant/` | `…/GT Ball Drop/admin/` |
| **Windows** | `%APPDATA%\GT Ball Drop\participant\` | `%APPDATA%\GT Ball Drop\admin\` |
| **dev (`npm run dev:*`)** | `./data/participant/` | `./data/admin/` |

Inside the participant folder: `config.json` (settings), `sessions/` (one folder per
session), and `host.json`. Inside the admin folder: `mirror/` (copies of sessions) and
`host.json`.

In browser mode, sessions are kept in the browser's own storage (IndexedDB for the site)
until downloaded.

**`host.json` holds the pairing codes. Treat it like a password file.** Delete it to
forget all pairings.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Browser mode lists a session **still in this browser** | A previous tab closed before its data was downloaded. **Download** it, then **Discard** it |
| Start screen says **No local host** | The game page can't reach its host, so data stays in browser storage only. Use the desktop app, or start `npm run dev:participant` |
| Admin shows **Cannot reach …** | Check the participant's IP address and that port 4280 is allowed through its firewall. The participant app must be running |
| Admin shows **Pairing code not recognised** | The code was already used or has been replaced. Get the current code from the participant's start screen |
| Commands are ignored (`"accepted": false`, or the admin panel says monitoring only) | Set `remoteControl.enabled: true` on the participant machine and restart it |
| `POST /api/command` returns 409 | Nothing can receive it: the game isn't open on the participant machine, or (on the admin machine) the admin isn't connected to the participant |
| `POST /api/command` returns 415 | Send the header `Content-Type: application/json` |
| A setting has no effect | Edit `config.json` while the app is closed, then restart it |
| Participant stuck on a screen with no buttons | Remote control is on. Use the admin panel or the control API, or press **9** |
| Controller not listed | Click **Connect a controller…** (Chrome, Edge, desktop app), or press one of its buttons so the browser lists it through the Gamepad API. A wireless controller may have gone to sleep: wake it (on a PlayStation controller, the PS button) |
| *"This browser didn't show a device chooser"* | The browser has WebHID but can't ask which device to use (some browsers built into other apps). Use Chrome, Edge or the desktop app, or press a button on the controller to use the Gamepad API |
| Low report rate on the meter (e.g. 50 a second) | The rate is the controller's own. A wireless controller can report less often over Bluetooth than over a USB data cable. Check the rate before each session |
| Controller moves the paddle the wrong way | Tick **Invert** |
| Wheel or stick needs too much movement | Lower `controller.positionReach` (setup screen: **Outer lanes reached at**) |
| The meter doesn't reach the ends at full throw | **Calibrate…** the range: move the control as far as it goes both ways |

---

For how this version relates to the original (what was ported exactly, what was changed and
why), see [FIDELITY.md](FIDELITY.md).
