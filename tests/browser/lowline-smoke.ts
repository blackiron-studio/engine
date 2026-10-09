import main, { LowlineScene } from "../../examples/lowline/src/main.ts";
import { App } from "../../src/app/app.ts";
import config from "../../examples/lowline/kiln.json";
import {
  angleDelta,
  distance,
  PICKUP,
  DROP,
  roadRoute,
} from "../../examples/lowline/src/city.ts";
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
const check = (v: unknown, m: string) => {
  if (!v) throw Error(m);
};
const capture = async (app: App, name: string) =>
  fetch("/capture?name=" + name, {
    method: "POST",
    body: app.canvas!.toDataURL("image/png"),
  });
try {
  const app = await App.create({ canvas: "#kiln", config: config as any });
  await main(app);
  app.audio.setMuted(true);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) app.frame(1 / 60);
  };
  const press = (action: string) => {
    app.input.press(action);
    frame();
    app.input.release(action);
    frame();
  };
  frame(3);
  await capture(app, "title");
  let s = app.scene as LowlineScene;
  press("confirm");
  app.input.press("right");
  frame(40);
  app.input.release("right");
  press("interact");
  check(s.run.vehicle, "Could not walk to and enter coupe");
  await capture(app, "play");
  const drive = (x: number, y: number, budget = 1200) => {
    const c = s.run.vehicle!.motor;
    for (let i = 0; i < budget && distance(c, { x, y }) > 52; i++) {
      const d = distance(c, { x, y }),
        angle = angleDelta(Math.atan2(y - c.y, x - c.x), c.angle),
        target =
          Math.abs(angle) > 0.45 ? 65 : Math.min(260, Math.max(70, d * 0.8));
      for (const k of ["left", "right", "up", "down"]) app.input.release(k);
      if (Math.abs(angle) > 0.035)
        app.input.press(angle > 0 ? "right" : "left");
      if (c.speed < target) app.input.press("up");
      else if (c.speed > target + 10) app.input.press("down");
      frame();
      if (s.run.phase !== "playing") break;
    }
    app.input.reset();
    return distance(c, { x, y }) < 60;
  };
  check(drive(1220, 1260), "Could not drive along Palm Boulevard");
  check(drive(1244, 700), "Could not turn and reach Records");
  press("interact");
  check(s.run.mission === 2, "Archive pickup failed");
  await capture(app, "chase");
  const loop = [
    { x: 1244, y: 284 },
    { x: 2180, y: 284 },
    { x: 2156, y: 1724 },
    { x: 260, y: 1724 },
    { x: 284, y: 284 },
  ];
  for (const p of loop) {
    drive(p.x, p.y);
    if (s.run.heat === 0) break;
  }
  check(s.run.phase === "playing", "Pursuit caused unfair immediate defeat");
  check(s.run.heat === 0, "Could not escape patrols on road loop");
  for (const waypoint of roadRoute(s.run.vehicle!.motor, DROP))
    check(drive(waypoint.x, waypoint.y), "Could not drive the delivery route");
  s.run.vehicle!.motor.stop();
  frame();
  press("interact");
  check(s.run.phase === "won", "Delivery failed");
  await capture(app, "victory");
  press("confirm");
  check(s.run.freeRoam, "Free roam did not start");
  press("pause");
  const paused = JSON.stringify(s.diagnostics);
  frame(20);
  check(paused === JSON.stringify(s.diagnostics), "Pause changed the city");
  press("confirm");
  s.run.health = 0;
  frame();
  check(s.run.phase === "lost", "Defeat failed");
  press("confirm");
  s = app.scene as LowlineScene;
  check(s.run.phase === "title", "Restart failed");
  frame(3);
  check(!errors.length, errors.join("\n"));
  await fetch("/result", {
    method: "POST",
    body: JSON.stringify({
      status: "PASS",
      checks: [
        "WebGL2 startup",
        "walk and enter vehicle",
        "driving and turn to archive",
        "actual road pursuit and escape",
        "delivery and free roam",
        "pause",
        "defeat and restart",
      ],
      diagnostics: s.diagnostics,
      renderer: app.renderer.stats,
      errors,
    }),
  });
  app.destroy();
} catch (error) {
  await fetch("/result", {
    method: "POST",
    body: JSON.stringify({
      status: "FAIL",
      error: String((error as Error).stack ?? error),
      errors,
    }),
  });
}
