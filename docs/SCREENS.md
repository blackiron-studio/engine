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

`app.screen`, also `scene.screenInfo`, describes the screen the game is shown on.

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

On a touch screen, `app.input.lastDevice` starts as `"touch"` (0.23.2), so hints and prompts
speak touch before the first tap. A key or a controller switches them as usual.

Scenes hear about screen changes through `onResize`, even when the logical size stays the same.
For example, a `fit` viewport keeps 1280 × 720 on every screen, but moving from an iPad to an
iPhone still calls it.

`scene.compact` is a shortcut for `scene.screenInfo.compact`. Use it next to `scene.wide` and
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

### Tablets: `ui.tabletPoints` (0.24)

```json
"ui": { "minPoints": 0.8, "tabletPoints": 1.2 }
```

A tablet is held as close as a phone but shows a 1280 × 720 design at about 0.92 points per
unit, so `minPoints` leaves it alone and 9-unit desktop text comes out at 8 points.
`tabletPoints` is a second floor for tablets only (touch, 600 points across or more). Phones
keep `minPoints`, since they have no room for more, and desktops are never grown. This is the
two-step form of Unreal's DPI curve.

### Inside the grown UI

`ctx.width` and `ctx.height` are always the logical size, and the pointer is always in logical
units. Inside a grown or fitted `ui` layer, convert:

- `scene.toUI(x, y)` turns a pointer or touch position into UI units;
- `scene.areaOf(node)` gives the width, height and insets of the layer a node draws in
  (`uiWidth` × `uiHeight` and `uiInsets` inside `ui`, the logical size elsewhere);
- `scene.inUI(node)` says whether a node is inside `ui`.

The engine's own UI does this since 0.23.2: `HintLayer`, the menus (dim, panel, rows),
`VirtualSticks`, `TouchControls` and tooltips. Sticks and touch controls inside `ui` take
their zones and `size` in UI units, so they grow with the HUD.

### Menus

The shell's menus (`TitleScene`, `PauseScene`, `SettingsScene`, `ControlsScene`, …) fit small
screens by themselves:

- on a touch screen every row is at least 44 points tall, however small a unit shows;
- rows keep 20 units clear of each edge;
- when the rows are taller than the screen they flow into side-by-side columns, evened out,
  and left and right move between them. The settings menu fits an iPhone SE held sideways in
  two columns.

`Row` and `Column` do the same for any layout with `wrap` (the longest a line may run) and
`lineGap`.

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

### Boxes that follow the screen (0.24)

`Anchor` can size its box from the screen, the way Unity's and Godot's stretch anchors do:

```ts
// A bottom bar from edge to edge, clear of the notch and home bar.
const bar = this.ui.add(new Anchor({ x: "stretch", y: "bottom", h: 64, safe: 12, safeArea: true,
  onLayout: (w) => this.layoutBar(w) }));
// A side panel a quarter of the screen wide, never under 220 units, full height.
this.ui.add(new Anchor({ x: "right", y: "stretch", wFrac: 0.25, minW: 220, safe: 12 }));
// A sheet that fills a phone and stops growing at 560 units, centred.
this.ui.add(new Anchor({ x: "stretch", y: "center", h: 400, maxW: 560, safe: 16 }));
```

`onLayout(w, h)` runs when the size changes; place the children there.

## Text that fits (0.24)

- `new Label(text, x, y, { maxWidth: 180 })` shrinks text wider than 180 units, down to
  `minScale` (0.7), then cuts it with "…". `overflow: "ellipsis"` cuts without shrinking.
- A `Button` does this to its own label.
- `ellipsize(text, maxWidth, measure)` does the cut for text you draw yourself.

## The system's text size (0.24)

`app.screen.systemTextScale` is the text size the player chose for the whole device: Dynamic
Type on iOS (the native host and Safari), the browser's default font size elsewhere on the
web. 1 is the default; it is clamped to 0.8–2. `Settings` multiplies its own "Text size" by
it, so `app.accessibility.textScale` and the theme font follow it, including when it changes
while the game runs. A game that draws its own text multiplies its sizes by
`app.accessibility.textScale`. `"ui": { "systemText": false }` turns it off. The Rust host
(Android, desktop) does not report it yet.

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

- every piece of text with its size in points, and whether it is UI text or scenery;
- every visible, enabled control with its size in points;
- the UI text under `ui.minTextPoints` (11);
- on touch screens, the controls narrower or shorter than `ui.minTouchPoints` (44).

**Scenery.** Text drawn in the world layer is scenery: a street sign, a label on a map. So is
text drawn anywhere with `{ scenery: true }`. Small scenery is listed in `smallWorldText` and
does not fail the screen, since the player need not read it to play. `blackiron screens` shows
it as a note.

**Targets a game draws itself.** A HUD drawn by hand, not with `Button`s, reports its tap areas
so they are measured too. Call `reportTarget` from `render`, in `ui` units, on every frame the
target is shown:

```ts
override render(ctx: DrawContext): void {
  ctx.rect(x, y, 120, 56, 0x202830);
  this.scene?.reportTarget("Garage", x, y, 120, 56);
}
```

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
blackiron screens --steps "frames:60;shot:title;key:Enter;frames:90;shot:play"  # the default
blackiron screens --strict                           # exit 1 when anything is too small
```

It waits a second before the title shot, so a title that fades in is measured. It prints one
line per shot. On a game that is not ready for phones yet, a line looks like this:

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
`scene.screenInfo.compact ? legibleScale(scene.screenInfo.pointsPerUnit, 0.85) : 1`. Its phone tests use
`createTestApp({ device })` instead of faking the window size.
