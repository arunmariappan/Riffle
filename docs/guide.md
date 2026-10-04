# Riffle player guide

How to use Riffle once it's running. For setup and development, see the [README](../README.md).

## Starting

Run `pnpm start` and open http://localhost:4173 in Chrome or Edge, then click **Enter the valley**. The first load in a
fresh browser profile compiles every shader, which takes up to about 1.5 minutes on Windows. Chrome caches the
shaders, so later loads are much faster. Without `pnpm assets`, the valley still runs with plain colors where the
ground textures would be.

### Install it as an app (optional)

In Chrome or Edge, use the install icon in the address bar (or ⋮ → Cast, save and share → Install page as app) while
`pnpm start` is running. Riffle then opens in its own window with a desktop shortcut.

## Controls

| Explore | |
|---|---|
| Click | Look around (Esc releases the mouse) |
| W A S D, Shift | Walk, run |
| Space / C | Jump, swim up / sink while swimming |
| F | Throw food onto the water ahead |
| E | Look at the fish in the middle of the view (Follow to trail it) |
| Tab | Build mode |
| P | Photo mode |

| Build | |
|---|---|
| Right-drag, middle-drag (or Shift + right-drag), wheel | Turn, pan, zoom (W A S D, Q E also pan and turn) |
| Drag a card from the catalog | Place it: a green ring means it can go there, red says why not. While dragging, the wheel turns it and Shift + wheel scales it |
| Click, Shift + click | Select, add to the selection |
| 1, 2, 3 · Delete | Move, turn, scale · remove |
| Ctrl + Z, Ctrl + Shift + Z | Undo, redo (100 steps) |
| Tab | Explore from here |

| Photo | |
|---|---|
| Right-drag · W A S D, Q E, Shift | Look · move, down and up, faster |
| Wheel · click | Zoom (focal length) · focus there |
| H · Esc | Hide the controls · back to exploring |

In Build mode, the panels control the water, wind, trees, time and weather, and the ecosystem (evolution, mutation,
predators, population caps, graphs and overlays). **⚙ Settings** has:
- the quality preset (Low, Medium, High, Ultra), dynamic resolution and a 30 or 60 fps cap;
- field of view, mouse sensitivity and inversion, head bob and softer lightning;
- the volume and this list of controls.

🔊 mutes.

## Saving

Riffle autosaves every five minutes and when you leave the tab, keeping the last three. The start screen offers to
continue from the latest one. **Valley ▾ → Save valley as…** writes a `.riffle` file with your edits, the settings,
the time and the whole ecosystem; **Open valley…** loads one. A valley is grown from its seed, so the files stay
small.

## Photos and time-lapses

In photo mode, **Take photo** averages 64–256 frames, each with a slightly shifted camera, lens and sun. That gives
smooth edges, real depth of field and soft shadows. It saves a PNG up to 4K. **Time-lapse** records a day, a season or
a year straight into an MP4 file, from a fixed camera or along a path through up to five keyframes. Long captures at
4K are heavy GPU loads, so keep them short on a machine that hasn't been stress-tested.

## If something goes wrong

- **"Riffle needs WebGPU"**: WebGPU isn't available. Update the browser, and check that `chrome://gpu` shows WebGPU as
  hardware accelerated.
- **The picture freezes and Riffle says the graphics device stopped**: the GPU driver reset. Riffle saves the valley
  and reloads it from the autosave by itself. If it happens again soon, it switches to a lighter preset.
- **No sound**: browsers start audio only after a click, so click the view once. Check 🔊 and the volume in
  ⚙ Settings.
- **Slow**: pick a lighter preset in ⚙ Settings, keep dynamic resolution on, or try the 30 fps cap.
