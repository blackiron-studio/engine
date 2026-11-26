# Small screens (0.23)

A game designed at 1280 × 720 fills an iPhone held sideways at about half a point per logical
unit. Text drawn 14 units tall shows at 7 points, and a 60 × 30 button is 31 × 16 points, far
under the 44 points a finger needs. Before 0.23 the engine knew the logical size but not the
physical screen, so every game had to guess. Signal Nine read `innerWidth` and the native host
by hand to do it.

0.23 gives the engine the same answer other engines give:

| Engine | What it does |
|---|---|
| Unity | Canvas Scaler: "constant physical size", or "scale with screen size" with a reference resolution and a match between width and height. `Screen.dpi` and `Screen.safeArea`. |
| Unreal | DPI scaling curve: the UI scale follows the screen's short side. Safe Zone widget. |
| Godot | Stretch modes and aspect, `content_scale_factor`, `DisplayServer.get_display_safe_area()`. |
| Cocos, Defold, Phaser | Design resolution and fit policies, plus the safe area. Layout by hand. |
| **Blackiron 0.23** | `app.screen` (points, insets, touch, size class), `ui.minPoints` (a constant-physical-size floor on the UI layer), safe-area anchors, device emulation, and `blackiron screens`, which measures text and touch targets on each device. |

The last part is something the others leave to device labs: every game can be checked headless
on an iPhone SE, an iPhone 15, an iPad and a laptop in one command, with every piece of text and
every button measured in points.

## The screen

`app.screen`, also `scene.screen`, describes the screen the game is shown on.

| Field | Meaning |
|---|---|
| `width`, `height` | The area the game owns, in points (CSS pixels on the web, UIKit points on iOS). |
| `pixelRatio` | Device pixels per point. |
| `insets` | Safe-area insets in points: top, right, bottom, left (notch, rounded corners, home bar). |
| `touch` | Touch is the main input: phones and tablets, not a laptop with a touch panel. |
| `orientation` | `"landscape"` or `"portrait"`. |
| `shortSide` | The shorter side in points. |
| `compact` | The short side is under 600 points, whatever the input. Lay the UI out for a small screen. |
| `sizeClass` | `"phone"` (touch, compact), `"tablet"` (touch, larger) or `"desktop"` (no touch). |
| `pointsPerUnit` | How many points one logical unit covers on screen. |
| `uiScale` | What `ui.minPoints` grows the UI layer by here (1 when it is off). |

Scenes hear about screen changes through `onResize`, even when the logical size stays the same.
For example, a `fit` viewport keeps 1280 × 720 on every screen, but moving from an iPad to an
iPhone still calls it.

`scene.compact` is a shortcut for `scene.screen.compact`. Use it next to `scene.wide` and
`scene.orientation` to pick a layout.

On the web, touch comes from `matchMedia("(pointer: coarse)")`. The insets come from
`env(safe-area-inset-*)`, so the page needs `viewport-fit=cover`, which the dev server and
`blackiron build` write. The native hosts report both.

## Growing the UI: `ui.minPoints`

```json
{ "viewport": { "width": 1280, "height": 720, "scale": "expand" },
  "ui": { "minPoints": 0.8 } }
```

With `minPoints` set, the scene's `ui` layer grows on small screens until one UI unit shows at
least that many points. The world layer is untouched; only the HUD, menus and controls grow. This
is Unity's "constant physical size" with a floor, and it plays the role of Unreal's DPI curve.

- 0.8 is the recommended value:
  - 14-unit text stays at 11 points or more, Apple's smallest text style;
  - a 55-unit button reaches 44 points.
- The growth is capped at `ui.maxScale` (2).
- On a laptop or an iPad, where a unit is already larger, the scale stays at 1, so a game set up
  this way looks exactly as before on desktop.
- While the UI is grown, `scene.uiWidth` and `scene.uiHeight` shrink to match. A phone held
  sideways might give 1069 × 491 UI units instead of 1559 × 720.
  - Layouts that use `uiWidth`/`uiHeight`, and `Anchor`, `Row`, `Column` and `Margin`, follow
    automatically.
  - Layouts that hard-code 1280 × 720 positions do not. Check them with `blackiron screens`.
- A scene that sets its own `ui.scale`, or calls `fitUI`, keeps control:
  - without `minPoints` the engine never touches `ui.scale`;
  - `fitUI` designs are scaled by `fitUI`, not by `minPoints`.

### `fitUI` on phones

`scene.fitUI(1280, 720)` shows a fixed design scaled to fit, and on a phone that means shrunk to
about 0.55. Choose a smaller design on compact screens instead. Lay it out with less on screen
and bigger controls:

```ts
override onResize(): void {
  if (this.compact) this.fitUI(800, 450); // a third fewer units, so everything is 1.6× larger
  else this.fitUI(1280, 720);
  this.layout();
}
```

`legibleScale(pointsPerUnit, minPoints, maxScale)` (from `@blackiron-studio/engine/app`) gives the
same growth factor as `minPoints` for anything you size yourself, such as world-space labels or a
game's own layout scale.

## The safe area

- `app.safeInsets` gives the insets in logical units.
- `scene.uiInsets` gives them in UI units. It accounts for the UI layer's scale and offset, so it
  is 0 on an edge that `fitUI` already letterboxes clear of the notch.
- `scene.safeRect` is the part of the UI layer clear of the notch and home bar.
- `new Anchor({ x: "right", y: "top", safeArea: true, safe: 8 })` keeps 8 units from the edge,
  plus the inset on each edge it is anchored to.

```ts
const pad = this.ui.add(new Anchor({ x: "left", y: "bottom", w: 180, h: 180, safe: 16, safeArea: true }));
```

## Trying a device

- **In a test:** `createTestApp({ device: "iphone-15" })`, or a `DevicePreset` object.
- **At run time:** `app.emulateDevice("iphone-se-portrait")`, or `null` to go back to the real
  screen.
- **In the browser:** add `?device=iphone-15` to the dev server URL. The page draws the device's
  outline and red bands over its safe-area insets.

Known devices, with sizes and insets in points as iOS reports them to a full-screen app:

| Name | Portrait size (pt) | Insets portrait (t, r, b, l) | Insets landscape (t, r, b, l) |
|---|---|---|---|
| `iphone-se` | 375 × 667 | 0 | 0 |
| `iphone-15` | 393 × 852 | 59, 0, 34, 0 | 0, 59, 21, 59 |
| `iphone-15-pro-max` | 430 × 932 | 59, 0, 34, 0 | 0, 59, 21, 59 |
| `android-small` | 360 × 800 | 0 | 0 |
| `ipad-mini` | 744 × 1133 | 0, 0, 20, 0 | 0, 0, 20, 0 |
| `ipad` | 820 × 1180 | 0, 0, 20, 0 | 0, 0, 20, 0 |
| `laptop` | 800 × 1280 (mouse) | 0 | 0 |
| `desktop` | 1080 × 1920 (mouse) | 0 | 0 |

- A device name alone uses landscape; add `-portrait` or `-landscape` to choose.
- `devicePreset(name, orientation)` and `DEVICES` are exported from
  `@blackiron-studio/engine/app`.

## Measuring: `app.auditScreen()` and `blackiron screens`

`app.auditScreen()` draws a frame and reports:

- every piece of text with its size in points;
- every visible, enabled control with its size in points;
- the text under `ui.minTextPoints` (11);
- on touch screens, the controls narrower or shorter than `ui.minTouchPoints` (44).

```ts
const app = await createTestApp({ device: "iphone-se", config });
app.scenes.change(new Hud());
stepFrames(app, 1);
expect(app.auditScreen().smallText).toEqual([]);
```

`blackiron screens` runs the game headless in Chrome on several devices, with no window. It plays
the same steps on each, saves a screenshot at every `shot:` step, and measures it.

```sh
blackiron screens                                    # iPhone SE, iPhone 15, iPad, laptop
blackiron screens --devices iphone-15-portrait,ipad  # pick devices
blackiron screens --steps "frames:3;shot:title;key:Enter;frames:90;shot:play"
blackiron screens --strict                           # exit 1 when anything is too small
```

It prints one line per shot. On a game that is not ready for phones yet, a line looks like this:

```
iphone-15-landscape        play       0.55 pt/unit, UI ×1.00  ✗ 41 texts under 11 pt (smallest 4.9 pt "x3"); 6 touch targets under 44 pt (Button "Reload" 33×16 pt)
```

It also writes `.blackiron/screens/report.json` and an `index.html` contact sheet that shows every
device side by side, with the problems listed under each screenshot.

- Steps are `frames:N`, `key:Code`, `hold:Code:N`, `press:action`, `tap:x,y`, `shot:name` and
  `eval:js`, as for `scripts/shoot.ts`, which also takes `--device` now.
- The game's orientation comes from `ios.orientation`, `android.orientation` or the viewport.
- When the game allows any orientation, touch devices are checked both ways.

## Moving a game over

1. Run `blackiron screens` and open the contact sheet.
2. Add `"ui": { "minPoints": 0.8 }` to `blackiron.json`.
3. Lay the HUD out in `uiWidth` × `uiHeight` with anchors (`safeArea: true` on the corners), or
   use `scene.compact` to choose a phone layout.
4. Run `blackiron screens` again until every shot reads ✓, then add `--strict` to CI.

Signal Nine moved first. It used to read `innerWidth` and the native host itself to decide how
large to draw on a phone. Its `uiScale` is now
`scene.screen.compact ? legibleScale(scene.screen.pointsPerUnit, 0.85) : 1`. Its phone tests use
`createTestApp({ device })` instead of faking the window size.
