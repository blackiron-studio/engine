import main, { BreachScene } from "../../examples/breach/src/main.ts";
import type { App } from "../../src/app/app.ts";
import { Vec3 } from "../../src/three/index.ts";
import { RELAYS } from "../../examples/breach/src/level.ts";
const check = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
/** Same complete gameplay acceptance on browser and native backends. */
export async function exerciseBreach(
  app: App,
  capture: (app: App, name: string) => Promise<void> = async () => {},
  render = true,
): Promise<BreachScene> {
  await main(app);
  app.audio.setMuted(true);
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) app.frame(1 / 60, { render });
  };
  const press = (name: string) => {
    app.input.press(name);
    frame();
    app.input.release(name);
    frame();
  };
  frame(3);
  await capture(app, "title");
  let s = app.scene as BreachScene;
  check(s.state.phase === "title", "Missing title");
  press("confirm");
  frame(20);
  check(s.player.grounded, "Player does not stand on station floor");
  await capture(app, "play");
  const z = s.player.position.z;
  app.input.press("up");
  frame(30);
  app.input.release("up");
  check(s.player.position.z < z - 1, "W did not move forward");
  press("jump");
  frame(10);
  check(s.player.position.y > 0.2, "Jump did not leave floor");
  frame(60);
  const saved = JSON.stringify(s.diagnostics);
  press("pause");
  const paused = JSON.stringify(s.diagnostics);
  frame(40);
  check(paused === JSON.stringify(s.diagnostics), "Pause changed simulation");
  press("confirm");
  check(s.state.phase === "playing", "Resume failed");
  press("weapon2");
  const ammo = s.weapons[1].ammo;
  press("fire");
  check(s.weapons[1].ammo === ammo - 1, "Scattergun did not fire");
  press("reload");
  frame(120);
  check(
    s.weapons[1].ammo === s.weapons[1].definition.magazine,
    "Reload failed",
  );
  press("weapon1");
  // Real capsule ascent through the authored ten-step staircase.
  s.player.teleport(new Vec3(-18, 0.05, 10));
  s.look.yaw = 0;
  s.look.pitch = 0;
  frame(5);
  app.input.press("up");
  frame(110);
  app.input.release("up");
  frame(10);
  check(s.player.position.y > 2.1, "Flagship staircase cannot be climbed");
  await capture(app, "gallery");
  // Exercise the complete mission using real hitscan queries and weapon cadence.
  for (let wave = 0; wave < 3; wave++) {
    for (const enemy of [...s.enemies]) {
      if (enemy.health <= 0) continue;
      s.player.teleport(
        new Vec3(enemy.position.x, 0.04, enemy.position.z + 2.8),
      );
      frame(3);
      for (let shots = 0; enemy.health > 0 && shots < 12; shots++) {
        const d = enemy.node.position.clone().sub(s.eye);
        s.look.yaw = Math.atan2(d.x, -d.z);
        s.look.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        s.weapons[0].update(1);
        press("fire");
        frame(7);
        if (s.weapons[0].ammo === 0) {
          press("reload");
          frame(85);
        }
      }
      check(
        enemy.health === 0,
        `Enemy ${enemy.id} did not receive real weapon damage`,
      );
    }
    check(
      s.enemies.every((e) => e.health === 0),
      "Wave not cleared",
    );
    const relay = RELAYS[wave];
    s.player.teleport(new Vec3(relay.x, relay.y + 0.05, relay.z + 2));
    frame(3);
    press("interact");
    check(s.state.relays[wave], "Relay interaction failed");
  }
  check(s.state.phase === "won", "Mission did not reach victory");
  check(s.state.kills === 12, "Incorrect encounter count");
  await capture(app, "victory");
  const old = s;
  await s.restart();
  frame(3);
  s = app.scene as BreachScene;
  check(s !== old && s.state.phase === "title", "Restart failed");
  check(
    old.physicsWorld.stats.bodies === 0 && old.combat.targetCount === 0,
    "Restart retained old physics or targets",
  );
  s.start();
  frame(3);
  s.combat.hitscan(
    s.eye.clone().add(new Vec3(0, 0, 0.6)),
    new Vec3(0, 0, -1),
    2,
    100,
    undefined,
    "drone",
  );
  check(s.state.phase === "lost", "Damage did not reach defeat");
  await capture(app, "defeat");
  await s.restart();
  frame(3);
  s = app.scene as BreachScene;
  s.start();
  frame(20);

  return s;
}
