# UI layout checks

Kiln's UI components can be themed and laid out with `Anchor`, `Row`, `Column`, `Grid` and `Scene.fitUI()`. A passing logic test does not prove that a menu fits a phone or that two hit targets do not cover each other. Add a geometry check for each important screen state and for the portrait and wide sizes the game supports.

```ts
import { auditUILayout, createTestApp, stepFrames } from "@kiln/engine/testkit";

const app = await createTestApp({ scene: titleScene });
stepFrames(app); // lets responsive layout and scroll positions settle
const issues = auditUILayout(titleScene);
if (issues.length) throw new Error(JSON.stringify(issues.map(issue => ({
  kind: issue.kind,
  controls: issue.controls.map(control => control.name || control.constructor.name),
  rect: issue.rect,
}))));
app.destroy();
```

For intentional card stacks and overlays, pass `allowOverlap: (a, b) => ...` with a narrow, named exemption. `ignore` can exclude an animated control that deliberately starts off-screen. The audit checks visible, axis-aligned screen bounds and clips scroll children. It does not assess typography, art direction, contrast, animation quality or 3D content; inspect rendered captures at each supported size as well.
