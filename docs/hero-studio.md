# Hero studio

How the homepage drone animation is made, and how to add a new frame size.

The pipeline is three stages. Onshape is the source of truth for geometry and
placement; the studio is where a human tunes how it looks and moves; the hero
component plays the result on the site.

```
Onshape assembly
      │  export as glTF (Resolution: Medium, Compress: off)
      ▼
scripts/hero-assets/build-hero.mjs --all
      │  one optimised drone.glb
      ▼
public/models/<design>/drone.glb  +  studio.json
      │                                  ▲
      │  _studio.html  ────tune────────  │   (human in the loop)
      ▼
app/components/HeroDroneScene.tsx  →  the site
```

## Why it is built this way

Two things drove the design, both learned the hard way.

**Onshape owns placement, KiCad owns the boards.** A PCB routed through Onshape
loses its silkscreen, soldermask and pad colour, because STEP carries none of
them. Early versions substituted KiCad-built board GLBs at the Onshape
transforms. That works and the code is still here (`export-boards.mjs`,
`place-boards.mjs`), but it was abandoned once the boards were cleaned up inside
Onshape: one export is simpler than two pipelines that must agree.

**The studio exists because the failures are visual.** Every serious bug found
while building this was invisible in code and obvious on screen: props orbiting
a point 7 mm off the hub, screws travelling with the wrong assembly, a board
rendering as a white blob. A human glancing at it spots those in a second. The
studio's job is to put a person in front of the real assembly with every knob
exposed.

## Stage 1: export from Onshape

Right-click the assembly tab, Export, then:

| Setting | Value | Why |
|---|---|---|
| Format | **GLB** | one binary file |
| Resolution | **Medium** | Fine multiplies triangles for no visible gain at hero scale |
| Compress | **off** | it applies Draco, and the build re-encodes with meshopt anyway. Draco's decoder needs a worker, which Hydrogen's CSP blocks |
| Include hidden instances | off | |

Chrome must have "Ask where to save each file" **disabled** or the download sits
behind a native dialog.

## Stage 2: build

```bash
cd scripts/hero-assets
npm install                      # first time only
node --max-old-space-size=8192 build-hero.mjs ~/Downloads/<export>.glb \
     ../../public/models/<design> --all --ratio 0.2 --error 0.008
```

`--all` keeps the entire assembly. `--ratio` and `--error` control decimation:
`error` is the real governor, so simple parts stop early while dense ones
collapse. For the 3-inch, 0.2/0.008 took 1.43M triangles to 600k and the GLB
from 9.4 MB to 6.0 MB with no visible loss.

What the build does, and why each step is not optional:

- **Merges primitives per material within each mesh.** Onshape emits one
  primitive per B-rep face; one payload mesh arrived with 3340 primitives across
  2 materials. Each primitive costs an accessor and a bufferView in the JSON
  chunk, so the file was ~9.8 MB of JSON wrapped around ~1.9 MB of vertex data.
- **Culls strays.** Several KiCad footprints have a broken 3D-model offset from
  easyeda2kicad that places geometry about 1.2 m from the board. Left in, they
  wreck the camera framing and every bounding box.
- **Keeps meshes shared.** No `flatten()` or `join()`: those bake node
  transforms into geometry, which would turn four identical arms into four
  copies. `dedup()` does the opposite.

## Stage 3: tune in the studio

Serve the repo and open
`/<...>/public/models/<design>/_studio.html`. Any static server works:

```bash
python3 -m http.server 8731     # from the repo root
```

The right-hand panel is grouped: look presets, the three lights plus bounce, the
spotlight, sequence timing, materials, and export. Two panels matter most:

**Inspect (click a part).** Click anything in the view. It reports the
normalised name, which material class matched it, **which beats claim it** (or
"NONE, it never moves"), triangle count and size in mm, and jumps the material
panel to that class. This is the fastest way to answer "why is that part the
wrong colour" or "why did that screw fly off with the wrong thing".

**Parts audit.** Every part family with its class, claiming beats and triangle
cost, filterable, with anything unclaimed flagged in red. Check this reads
0 orphans before you call a design done.

When it looks right, press **copy settings JSON** and paste the values into
`studio.json`.

## The three name hazards

Almost every wrong-part bug in this project traces to one of these. three.js
mangles names on import:

1. It appends `_1`, `_2` to duplicates. `_` is a **word character**, so `\b` in
   a regex silently fails: `/pad\b/` does not match `4in1-mini_pad_744`. This
   alone had ~1900 board meshes falling through to a catch-all material.
2. It turns spaces into underscores: `Top Casing` arrives as `Top_Casing`.
3. It **deletes** `[ ] . : /` entirely
   (`three/src/animation/PropertyBinding.js`). `Airtag/Antenna-Mount` arrives as
   `AirtagAntenna-Mount`, so a config regex containing a slash never fires.

Onshape additionally wraps every part in `occurrence_of_<name>`.

`tidy()` in both the studio and the hero component undoes 1, 2 and the Onshape
prefix. **It does not yet handle 3.** If a part is silently getting the wrong
material, check for a deleted character in its name first.

## Colour

Onshape's exporter writes 8-bit sRGB values into glTF's `baseColorFactor`, which
the spec defines as **linear**. Measured on the 3-inch export: 183 of 183
components are exact `n/255`. Both the studio and the hero decode this on load.

Consequence: never set a material `tint` to fix brightness. If something looks
washed out, the decode is broken, not the colour. Tint only where the CAD colour
is genuinely absent, which today is the PCB soldermask, silkscreen, pads and
core.

## Adding a new frame size

Say you are adding the 5-inch.

1. **Export and build** as above into `public/models/od5/`.
2. **Copy `od3/studio.json` to `od5/`** and edit:
   - `name`, and `model` if the GLB has a different filename.
   - `boards[]`: the id must be the KiCad board name as it appears in the node
     names, e.g. `OpenFC`, `4in1`, `OpenRX-Gemini`. Get these from the parts
     audit.
   - `materials[].match`: the regexes are name-based and the 5-inch uses
     different motors and mounts. Work through the parts audit until it reads
     0 orphans and no material class has zero members.
   - `videoModule`, `notFrame`, `boardExclude`: same exercise.
   - `beats[]`: ids, titles and notes are free text; `select` is one of
     `{none}`, `{board: "<id>"}`, `{cluster: "<regex>", withProp: true}` or
     `{complement: true, plus: "videoModule"}`.
3. **Copy `_studio.html` into the new folder** and open it. Tune, then paste the
   settings back into `od5/studio.json`.
4. **Render the hero** with `<HeroDroneScene model="od5" />`.

### What will not work without code changes

Be aware before you start. These are hardcoded in `HeroDroneScene.tsx`:

- **Props are found by occurrence name being all digits** (`occurrence_of_1`),
  which is Onshape's default part name. If the 5-inch props are named
  "HQ 5x4.3x3" you get zero pivots and no spin, with only a `console.warn`.
- **Motors are clustered with a 15 mm tolerance** and props matched within
  30 mm. Both are absolute distances tuned to a 3-inch.
- **Four props are assumed**, and prop handedness is inferred from
  `sign(dx * dz)` about the drone's bounding-box centre. A hexacopter, an X8, or
  an asymmetric layout will be wrong.
- **The teardown expects a part named exactly `Top`.** No match means the top
  plate never lifts, silently, while the caption still says it does.
- **Board bounding boxes are padded on the wrong axes** (the code pads X and Y
  as the board plane, but the scene is Y-up so the board normal is Y). It works
  today only because `boardExclude` names every standoff and screw that the
  wrong-axis over-grow would otherwise sweep in. Components taller than about
  2.5 mm on a new board may not be claimed by it.
- **`build-hero.mjs` culls anything beyond 0.25 m** from the origin. A 3-inch is
  ~0.14 m corner to corner; a 7-inch is ~0.30 m, so **real parts would be
  deleted**, logged only among hundreds of lines. Raise `FAR_RADIUS` before
  building anything larger.

## Studio and hero: what is shared and what is not

The hero component is the studio's scene core minus the tuning panel. It is
deliberately vanilla three.js in a ref container rather than react-three-fiber,
because the studio version is the one that has been debugged against the real
assembly.

They are **not** one source of truth yet:

| | reads `studio.json` |
|---|---|
| `HeroDroneScene.tsx` | yes: lighting, spotlight, sequence, camera, materials, boards, beats |
| `_studio.html` | **no**, it hardcodes the same values |

So the loop today is: tune in the studio, copy the numbers into `studio.json`,
and the hero picks them up. Making the studio read the file is the obvious next
step and would remove the copy step entirely.

Structure is duplicated in both: the teardown choreography, prop rigging, board
merging and beat selection exist twice. Changing one without the other will
cause drift. That duplication is the main known debt.

## Known debt

Kept here rather than in commit messages so it stays visible.

- `_studio.html` does not read `studio.json`.
- The choreography, prop rigging and group membership rules are code, not
  config, so a new design with a different structure still needs edits.
- The studio's "copy settings JSON" output does not match `studio.json`'s shape
  and omits about half the panel.
- Failures are mostly `console.warn`, not visible. A beat that resolves to zero
  nodes still runs, still spotlights nothing, and still shows its caption, which
  reads as an animation bug rather than a config one.
- `tidy()` does not undo three.js's character deletion.
- `build-hero.mjs` still contains a dead non-`--all` code path that is the
  default, and produces GLBs the studio cannot load.

## Review findings

An adversarial review of the hero component produced the list below. Fixed
items are struck through in intent; open ones are real and unaddressed.

### Fixed

- **One trackpad flick played the whole sequence.** A momentum tail fires at
  frame rate for a second or more after the finger lifts, and a time-based
  "gesture ended" test cannot tell it from real input. The fix is to bound the
  distance instead: within one gesture the target can never travel more than one
  stop from where it began. Verified: 45 events including a decaying tail now
  land exactly on `stopFor(gestureFrom + 1)`.
- **Scroll trapped the reader at both ends.** Release is now keyed off which
  stop the gesture began at, with a margin, rather than a raw position that
  happened to coincide with the last snap point.
- **ctrl+wheel was swallowed**, blocking pinch and browser zoom.
- **Firefox scrolled about 20x slower**: `deltaMode` was assumed to be pixels.
- **An unguarded render loop** would throw 60 times a second forever with
  nothing visible. Now caught, with the loop stopped after three errors.
- **A leaked WebGL context per remount.** `dispose()` does not release the
  context; `forceContextLoss()` is now called, and the PMREM generator, its
  render target, all cloned materials, the dim twins and the merged and source
  board geometries are disposed.
- **The loop ran off screen and in background tabs.** Gated on an
  IntersectionObserver and `document.hidden`.
- **Prop pivots leaked into the airframe teardown** because the group was never
  named, so the `notFrame` exclusion could not match it.
- **Progress never reached 0 or 1**, so the rail fill never lined up with its
  own dots. Progress is now measured across the stops, not the raw timeline.
- **Every failure path left a permanent LOADING overlay.** `onReady` now fires
  from the catch too.
- **No context-loss recovery.**
- **Five of six beats existed only in JS state**, invisible to crawlers and
  screen readers. All beat copy is now in the DOM, visually hidden while the 3D
  drives presentation and becoming the actual content when it does not.
- **No keyboard path.** Arrows, PageUp/Down and Home/End step between stops, and
  the rail dots are real buttons with `aria-current`.
- **No reduced-motion or small-screen gate.** Now matches the policy the rest of
  the site already uses: no 3D under 768px or under `prefers-reduced-motion`.

### Still open

- **No touch support.** The gate above means phones get the DOM copy rather than
  a broken scene, but tablets over 768px will load the 3D and be unable to drive
  it. A `touchmove` path is the missing piece.
- **The 3D is hardcoded dark** and does not follow the site's light/dark toggle.
  Hemisphere and beam colours are literals, and `darkenRest: 1.0` would drive
  non-focused parts to black on a white page.
- **`stops` is parsed and never used**, so the second caption of the airframe
  beat ("Video module") never appears even though the choreography runs.
- **No tiered loading.** The 6 MB GLB blocks the first frame.
- **The shader warm-up was not carried over** from the studio, so the first
  spotlight compiles shaders during the reader's first scroll.
- **`mergeGeometries` is one unchunked call**, where `HeroScene.tsx` deliberately
  chunks it.
- **About half the component is copy-pasted from `_studio.html` and has already
  drifted**: staging distance, the fastener regex, motor clustering, and
  `boardTilt`. This is the main structural debt.
