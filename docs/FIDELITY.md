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

| Ground | 1000 × 1000 × 34.2 box at (−500, 2, −34.2) | its top face is the floor at z = 0, from just behind the lanes to the horizon |
| Pit walls | 8 boxes, 0.2 × 2.3 × 257.6, at x = lane edge − 0.1, y −0.3, z −257.6 | the fire pits are open shafts between them |
| Dividers (exact) | 8 cylinders, r 0.1, 200 tall, at x = ±1, ±3, ±5, ±7, y 2.0 | |
| Fire effects | 2 per pit at (lane x, 1, −1): FireEffect(r 1, h 5, intensity 0.4, speed 24) and (1, 1.5, 0.25, 16) | |
| Materials | every geometry node references material 26, `new_wall` | a gravel texture (see [Textures](#textures)) |

`BallCatcher_RED.mdl`: a torus plus a cylinder, outer radius about 0.5, ring about 0.13 above
the slot. `GTBall_BLUE.mdl`: a sphere of radius about 0.25.

Display: `variables.cfg` set 1024×768, so the view is letterboxed to 4:3.

## World versions and the skybox

The C4 build shipped two world versions, and `config.world` picks one:

| `world` | C4 world | Default in | Look |
|---|---|---|---|
| `classic` (default) | `GTBallDrop_NO_PT_LIGHTS` | May 2011 until Oct 2012 | "Bright" skybox (cloud ceiling, sun overhead), hazed about halfway to white by the fog; yellow `Flame` pits. Generated procedurally in the port, see [Textures](#textures) |
| `clean` | `GTBallDrop_clean` | commit `04e42b8`, Oct 17 2012, onward | no skybox; a ClearProperty makes the background pale yellow (1, 1, 0.63); `red_flame` pits |

Both worlds share the rest: the geometry, the fog space, one light, and the ambient light.

A lab's `variables.cfg` could override `GTBallWorldFilePath`; the one-time converter
(`tools/convert-c4-config.ts`) maps it to `appearance.world`.
The URL parameter `?world=classic` forces a world for side-by-side comparison.

### Textures

The port uses the original's `red_flame` and `blue_flame`, decoded from C4's `.tex` format
by `tools/c4-assets/`. The other textures are generated procedurally
(`apps/game-web/src/procedural.ts` and the sky shader in `renderer.ts`):

| Original | Port |
|---|---|
| "Bright" skybox: a sunlit, broken cloud ceiling fading to a bright horizon, blue below | shader: domain-warped fBm clouds projected onto a plane overhead, a horizon haze, blue below. Drawn on the same unit cube, and fogged with C4's formula |
| `C4/noise` (the fire shader's distortion) | seamless fBm in R and G, rescaled to the original's measured statistics (R mean 0.448, sd 0.18; G 0.588, 0.193), since the flames' motion and downward bias depend on them |
| `texture/Wall` (gravel on the ground, pit walls and poles) | seamless cellular pebbles with fBm grit |
| `texture/Flame` (the classic look's yellow pits) | `red_flame`, recoloured yellow-white |

**Fire** is a port of C4's `FireEffect` (a billboard quad) and its fire shader: three
scrolling noise samples distort the flame texture's UVs, with the noise speeds taken from
`FireAttribute::CalculateNoiseVelocities`. As in C4 it is alpha-tested (`alpha > 0`, the
default `alphaTestValue`) and added at full texture colour (`kBlendAccumulate` = ONE, ONE).
A missed ball gets two `FireEffect(1.5, 5, 0.5, 100)` with blue_flame, as in
`BallController::Burn`.

Flame height, from the source. The node table (decoded with `Node::Pack`'s layout: parent
index, object index, flags, 4×4 transform) puts both pit fires under the lane's group, as
siblings of the burn trigger. So they are at (lane x, 1, −1), with heights 5 and 1.5. A
simulation of the shader with the real noise and flame textures puts the visible top of
the tall flame at **z ≈ 2.4 (red_flame)** and **z ≈ 1.9 (Flame)**, above the paddle
(z 0.2–0.46) and 0.5 units in front of it. The port reproduces that. If an old screenshot
or video shows lower flames, something in the original setup differed from these files
(for example a different world, or a GPU that couldn't run the fire shader).

**Deliberate change:** by default the pit flames are drawn at **half height and 70%
brightness** (`appearance.flameHeightScale: 0.5`, `appearance.flameOpacity: 0.7`), a lab
decision so the flames don't cover the paddle. Set both to 1 for the C4 original. The values
are logged in every session's `config.json` and `session-started` event.

**Deliberate change:** the ball and paddle get some diffuse shading
(`appearance.modelShading: 1`, full shading). The May 2011 "high contrast" models (GTBall_BLUE,
BallCatcher_RED) set emission equal to diffuse. In C4 emission is added in the ambient
pass, so the colour channel saturates and the models render flat apart from the specular
highlight. The earlier models (GTBall: dark blue, textured and bump-mapped; BallCatcher:
metal plate, bump-mapped) were shaded. `modelShading` 0 reproduces the high-contrast
materials exactly. s > 0 scales emission by (1 − s) and diffuse by (1 − 0.45 s), keeping the
hue. `?shading=` in the URL overrides it for comparison (not logged).

## Interaction audit (Sep 2026)

Checked against the C++ and the C4 engine source.

| Aspect | Original | Port | Status |
|---|---|---|---|
| Catcher motion | Hooke's-law spring (k 200, m 0.5), critically damped (b = 2√(km) = 20), RK4, integrated each frame with dt in seconds | Same code, integrated every 1 ms | same; RK4 at 16 ms and at 1 ms differ by far less than a pixel |
| Catcher settling | halts when \|pos\| and \|vel\| ≤ 0.01, or when it crosses the target (critical-damping flag) | same | same: about 91% of a lane change in 200 ms, fully stopped at about 0.53 s |
| Catcher extras | the "base spin" and tilt code targets a subnode this model doesn't have; mouse-look values are computed but never used | none | same (no visible effect in either) |
| Keys | Left/Right and A/D, one lane per press, auto-repeat ignored | same | same |
| Input timing | polled once per frame; a press and release inside one frame could be lost | each key is applied at its own event timestamp (≤ 1 ms) and never lost | **better**, deliberately |
| World clock | whole-millisecond ticks with a carried remainder; a frame's delta capped at 250 ms | 1 ms steps; a call is capped at 5 s | same in normal running |
| Spawn interval | a spawn is due at `last + spawnTime`, but is checked only once per frame, and `last` is set to that frame's time, so each interval is rounded up to a frame boundary (about +8 ms on average at 60 fps) | exact to the millisecond | **differs slightly**: about 1% at 750 ms, up to about 8% at the 100 ms minimum. Frame-rate dependent in the original, so it isn't emulated |
| Ball fall | constant speed × dt, spin 1°/ms | same | same. The spin is invisible, because the ball has no texture |
| Ball look | GTBall_BLUE: diffuse + emission (0, 0, 1), white specular (exponent 47), no texture | same material; extra shading via `modelShading` | same |
| Catcher look | BallCatcher_RED: diffuse (1, 0.02, 0), emission (1, 0, 0), white specular (exponent 27) | same material | same |
| Catch effect | SparkSystem(100): blue line particles, 0–749 ms life, up to 0.04 units/ms, gravity −9.8e-6 units/ms², fading over the last 100 ms; streaks 16.67 ms of travel long and 0.5 wide, a sharply peaked particle texture, (SRC_ALPHA, ONE) | same | same |
| Miss effect | 2 × FireEffect(1.5, 5, 0.5) blue_flame on the ball | same | same |
| Sound | none (all sound code is commented out) | none | same |
| Mouse cursor | the interface manager shows it only while a window is open | hidden during play | same |
| Moves during a pause | while paused, `DemoController::Move` still runs (dt forced to 0.01 ms). Whether the key actions reach it while a dialog has focus depends on C4's input routing, which I didn't trace | ignored while paused | **unverified** |
| Dialog keys | Enter/Esc; hidden 9/0 on non-interactive screens | same | same |
| Display | 1024×768, horizontal FOV 53.1° | letterboxed 4:3, same FOV | same |

## Camera, lighting and fog (from the engine source and the world file)

* **Camera:** `ChaseCamera` is `FrustumCamera(focal 2.0)`. C4 sets the aspect to
  height/width, and a ray at the screen edge is `(±1, ±aspect, focal)`, so at 1024×768 the
  field of view is 53.1° horizontal and **41.1° vertical**. The bottom edge of the screen
  is at about z ≈ 0 in the lane plane, just under the paddle, and balls enter from just
  above the top edge.
* **Light:** one infinite light, white, from direction (−0.008, −0.531, 0.847) (its local
  +Z). Its flags are 0, so it casts shadows: the poles throw long shadows back across the
  ground. **Ambient:** the infinite zone's ambient is 0.616 grey. Lighting is done in gamma
  space with no colour management, as C4 did.
* **Fog:** a fog space (node 2, object 8), identical in both worlds:
  * constant density 0.05, white;
  * its plane is at y = 2, facing the camera, so fog fills everything behind the lanes;
  * the plate is 15.5 × 7.1 and only decides whether the fog is active; the fog applies to
    the whole half-space.
  * Ported from `ConstantFogProcess`: factor = exp(−density × d), where d is the length of
    the view ray beyond the plane, blended toward the fog colour.
  * The skybox isn't fog-inhibited (flags 0). It uses C4's "infinite vertex" variant: plane
    distances are taken 1024 units out, but the ray length is |camera − v| in the unit
    sky cube's own space (about 13.5). That is why the classic sky shows through, washed
    about halfway to white, instead of being fully fogged.

## Approximations

* **Catch contact.** The original used rigid-body contact against the catcher mesh. The
  port counts a catch when the ball's centre is within 0.75 horizontally of the catcher
  (ring radius + ball radius) and its z is between −0.05 and 0.63. For a ball falling
  down the lane centre, I estimate (not measured) that this matches the first touch to
  within about ±0.1 units.
* **Burn** at ball-centre z ≤ −0.25 (trigger top −0.5, minus the trigger's 0.25 radius).
  **Kill** at z ≤ −2.25.
* **Look:** the geometry, camera, sky, fog, lighting, textures, materials, fire and sparks
  are recovered. Stand-ins: the shadow filtering (three.js PCF, not C4's shadow maps), and
  three.js's Blinn-Phong specular in place of C4's. `new_wall`'s material data could not be tied to its id with
  certainty. It is either Wall-textured (the assumption made here) or plain.
* **Texture tiling** on the ground, walls and poles is a guess. C4's box and cylinder UV
  generation wasn't ported.
* **Timestamps** are printed with 3 decimals (`12.345`). C4's `Text::FloatToString`
  format is unknown. The DATE/TIME header uses `MM/DD/YYYY` and `HH:MM:SS`, also a guess.
* **Random numbers:** a seeded sfc32 instead of C4's `Math::Random`. The distributions are
  the same but the sequences differ. The seed is logged in `session-started`.
* **Float precision:** doubles instead of 32-bit floats. Logged values are rounded to 6
  significant digits.

## Faithful on purpose (including odd behavior)

* Every `GTBall*` variable name, via the one-time converter `tools/convert-c4-config.ts`.
  The defaults follow `Game::Game()` except for the lab's choices listed under
  [Deliberate changes](#deliberate-changes).
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
| 9 | Defaults (`Game::Game()`): 5 balls per block, speed 0.001, a ball every 750 ms, stay chance 50%, calibration on with 5 balls per calibration block and a target catch rate of 0.8. | 200 balls per block, speed 0.01, a ball every 400 ms, stay chance 0 (always change lanes), calibration off, 100 balls per calibration block, target 0.85. | Lab decision (Sep 2026). Only affects settings a config leaves out. The C4 converter fills missing variables with the C4 defaults, not these. |

## New data (not in the original log)

These are in `events.jsonl` only. The legacy log is unchanged.

`ball-spawned` (lane, speed), `ball-caught` / `ball-missed` (lane, catcher position),
`ball-removed`, `catcher-moved` (including presses at the edge), `screen-shown` /
`screen-dismissed` (and who dismissed it), `admin-command` (accepted or not),
`clock-sync`, and `session-started` (the full config and RNG seed).
