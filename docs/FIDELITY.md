# Fidelity to the C4 original

What was carried over exactly, what was measured, what was approximated, and every
deliberate behavior change. Source references are to `BallDropGame/GTBallDrop/`.

## How it was checked

* **Logic:** ported line-by-line from `BallMagister.cpp`, `GTDemoChar.cpp`,
  `SimpleBall.cpp`, `Spring.cpp` and `Game.cpp`.
  * The C4 build could not be run (Windows, VS2012, defunct engine), so the expected values
    in `packages/core/test` were **traced by hand from the C++**. They were not recorded
    from a running original.
  * If an old build still runs somewhere, recording one session's `event_log.txt` with a
    known config would allow a direct comparison.
* **Geometry:** read from the binary C4 assets by locating node transforms and primitive
  parameters (method below).

## Measured from the assets

`GTBallDrop_clean.wld` (Z up):

| Item | Value | Notes |
|---|---|---|
| "Paddle Slots" (catcher locators) | x = −6, −4, … 6; y = 1.5; z = 0.2 | 7 lanes, 2 units apart; `MIDDLE` at x = 0 |
| "Ball Drops" (spawn locators) | same x; y = 1.5; z = 10.4 | |
| "Camera Config" | camera (0, −12, 4.9), look-at (0, 0, 4.9) | |
| "Fire Pits" (burn triggers) | 2×2×2 boxes, one per lane, node offset (−1, 0, −2.5) | top at z = −0.5; each has two red-flame effects |
| Kill trigger | 14×2×5 box, offset (−7, 0, −6.5) | top at about z = −2.5 (a parent offset is ambiguous) |
| Dividers | 8 cylinders | drawn as posts between lanes |

`BallCatcher_RED.mdl`: a torus plus a cylinder, outer radius about 0.5, ring about 0.13 above
the slot. `GTBall_BLUE.mdl`: a sphere of radius about 0.25.

Display: `variables.cfg` set 1024×768, so the view is letterboxed to 4:3.

## Approximations

* **Catch contact.** The original used rigid-body contact against the catcher mesh. The
  port counts a catch when the ball's centre is within 0.75 horizontally of the catcher
  (ring radius + ball radius) and its z is between −0.05 and 0.63. For a ball falling
  down the lane centre, I estimate (not measured) that this matches the first touch to
  within about ±0.1 units.
* **Burn** at ball-centre z ≤ −0.25 (trigger top −0.5, minus the trigger's 0.25 radius).
  **Kill** at z ≤ −2.25.
* **Camera field of view:** 58° vertical, chosen so the drop point and the fire pits are
  both in view. C4's value is not in the world file.
* **Look:** materials, lighting, flames and sparks are stand-ins for the C4 shaders and
  particle systems. The layout is measured; the look is not.
* **Timestamps** are printed with 3 decimals (`12.345`). C4's `Text::FloatToString`
  format is unknown. The DATE/TIME header uses `MM/DD/YYYY` and `HH:MM:SS`, also a guess.
* **Random numbers:** a seeded sfc32 instead of C4's `Math::Random`. The distributions are
  the same but the sequences differ. The seed is logged in `session-started`.
* **Float precision:** doubles instead of 32-bit floats. Logged values are rounded to 6
  significant digits.

## Faithful on purpose (including odd behavior)

* All the defaults from `Game::Game()` (see `packages/protocol/src/config.ts`), and every
  `GTBall*` variable name, via `importLegacyVariables`.
* Legacy log lines and their order, including the `*_DESCRIPT` header lines and the
  column numbering in `BALL_CATCHER_LEFT/RIGHT` (+3 = far left, left press increments).
* Experiment time pauses during every dialog.
* Calibration:
  * The practice block (−1) is unscored.
  * The staircase halves its steps on every direction flip, with integer halving of the
    spawn step.
  * Calibration ends after more than `maxRefinements` flips.
  * Intermediate breaks auto-continue after 2 s. The original hard-coded this with a
    `//TODO: only for testing`; here it's `calibration.autoContinueMs`, set to 0 to wait.
  * An empty block (NaN catch rate) counts as on target.
* After calibration, both the "calibration complete" and "experiment begins" dialogs
  appear.
* The calibration-complete dialog stays interactive even in admin-controlled mode.
* Hidden experimenter keys on non-interactive dialogs: **9** = continue, **0** = quit.
* Only balls that exist are counted. Balls still in flight when a block ends are removed.

## Deliberate changes

| # | Original | Port | Why |
|---|---|---|---|
| 1 | The spawn time is `unsigned long`. Stepping it below 0 wraps to about 4.3e9 ms (e.g. 750 → 550 → 350 → 150 → wrap), and the `< min` clamp never fires, so balls stop dropping. | Clamped to `spawnTimeMinMs`. | Bug. Reaching it only takes four "too easy" blocks in a row. |
| 2 | `_currColumn` is not reset when the catcher recentres between blocks, so later `BALL_CATCHER_*` columns are offset or missing. | Reset on recentre. | Bug. New `catcher-moved` events also carry the true lane. |
| 3 | Neighborhood mode calls `Math::Random(0)` when there are no neighbours. | Stays put. | Undefined behavior. |
| 4 | An admin "end block" (byte 0) sent during a pause is queued, and silently ends the *next* block the moment it starts. | Accepted only while a block is running. Otherwise it's rejected, and the rejection is logged. | The old admin could get into this state. |
| 5 | An admin "quit" (byte 2) during calibration ran one more staircase step and kept calibrating. | Ends the calibration block, then the experiment. | Quit should quit. |
| 6 | After `DoBlockBegin` pauses, the same frame could still spawn a ball behind the intro dialog. | The first ball waits for the dialog to close. | The ball was frozen behind the dialog anyway. |
| 7 | Balls left over from an admin-forced calibration block carried into the next one and were counted there. | Cleared at every block boundary. | Stats belong to one block. |
| 8 | The admin guessed the game state by counting its own button presses. | The admin reads the live status. | Removes a stuck-dialog failure mode. |

## New data (not in the original log)

These are in `events.jsonl` only. The legacy log is unchanged.

`ball-spawned` (lane, speed), `ball-caught` / `ball-missed` (lane, catcher position),
`ball-removed`, `catcher-moved` (including presses at the edge), `screen-shown` /
`screen-dismissed` (and who dismissed it), `admin-command` (accepted or not),
`clock-sync`, and `session-started` (the full config and RNG seed).
