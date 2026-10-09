import type { App } from "@kiln/engine/app";
import {
  Scene,
  Node2D,
  Graphics2D,
  type DrawContext,
} from "@kiln/engine/scene";
import { Rng } from "@kiln/engine/core";
import { CityRun } from "./game.ts";
import {
  SIZE,
  XS,
  YS,
  buildings,
  PICKUP,
  DROP,
  distance,
  type Car,
} from "./city.ts";
import { C, text, buildCity, carArt, personArt } from "./presentation.ts";
export class LowlineScene extends Scene {
  readonly run = new CityRun();
  readonly actors = new Node2D();
  readonly carNodes = new Map<Car, Node2D>();
  readonly pedestrianNodes: {
    node: Node2D;
    route: { x: number; y: number }[];
    index: number;
  }[] = [];
  readonly playerArt = personArt(C.gold);
  readonly marker = new Graphics2D();
  mapOpen = false;
  private soundClock = 0;
  private skidClock = 0;
  private marks: { node: Graphics2D; life: number }[] = [];
  constructor() {
    super(1280, 720);
    this.name = "lowline";
  }
  override ready() {
    buildCity(this.world);
    this.world.add(this.actors);
    this.actors.add(this.playerArt);
    const rng = new Rng(51);
    for (let i = 0; i < 32; i++) {
      const col = i % 4,
        row = Math.floor(i / 4) % 3,
        x = XS[col] + 76,
        y = YS[row] + 76;
      const route = [
        { x, y },
        { x: XS[col + 1] - 76, y },
        { x: XS[col + 1] - 76, y: YS[row + 1] - 76 },
        { x, y: YS[row + 1] - 76 },
      ];
      const index = i % 4,
        node = this.actors.add(
          personArt(rng.pick([0xc6a281, 0x76a8a3, 0xd28580, 0x9695b4])),
        );
      node.x = route[index].x;
      node.y = route[index].y;
      this.pedestrianNodes.push({ node, route, index: (index + 1) % 4 });
    }
    this.world.add(this.marker);
    this.marker
      .ellipse(0, 0, 35, 35, { color: C.gold, alpha: 0.18 }, 32)
      .polyline(
        Array.from(
          { length: 33 },
          (_, i) =>
            [
              Math.cos((i / 32) * Math.PI * 2) * 28,
              Math.sin((i / 32) * Math.PI * 2) * 28,
            ] as const,
        ),
        2,
        C.gold,
      )
      .polygon(
        [
          [-8, -47],
          [8, -47],
          [0, -36],
        ],
        C.paper,
      );
    this.camera.bounds = { x: 120, y: 120, w: 2300, h: 1930 };
    this.camera.snap = false;
    this.camera.zoom = 1.1;
    this.camera.follow(this.run.position, 5);
    this.ui.add(new LowlineHUD(this));
    this.sync();
    this.resources.defer(
      this.app.platform.onVisibility((v) => {
        if (!v && this.run.phase === "playing") this.pause();
      }),
    );
  }
  pause() {
    this.run.phase = "paused";
    this.timeScale = 0;
    this.app.input.reset();
  }
  resume() {
    this.run.phase = "playing";
    this.timeScale = 1;
    this.app.input.reset();
  }
  override onAction(action: string, pressed: boolean) {
    if (!pressed) return;
    const r = this.run;
    if (action === "mute") {
      this.app.audio.toggleMuted();
      return;
    }
    if (action === "map") {
      this.mapOpen = !this.mapOpen;
      return;
    }
    if (action === "confirm") {
      if (r.phase === "title") {
        r.start();
        this.app.audio.play("ll-start");
        this.app.audio.setMood("ll-night");
      } else if (r.phase === "paused") this.resume();
      else if (r.phase === "lost") this.app.scenes.change(new LowlineScene());
      else if (r.phase === "won") {
        r.freeRoam = true;
        r.phase = "playing";
        r.mission = 4;
        this.timeScale = 1;
        r.say("FREE ROAM / The city is yours. R starts a new dispatch.");
      }
    }
    if (action === "pause") {
      if (r.phase === "playing") this.pause();
      else if (r.phase === "paused") this.resume();
    }
    if (
      action === "restart" &&
      (r.phase === "paused" ||
        r.phase === "lost" ||
        r.phase === "won" ||
        r.freeRoam)
    ) {
      this.app.scenes.change(new LowlineScene());
      return;
    }
    if (action === "interact") r.interact();
    if (action === "horn" && r.phase === "playing")
      this.app.audio.play("ll-horn");
  }
  override onPointerDown(x: number, y: number) {
    if (this.run.phase === "title" && x > 65 && x < 400 && y > 477 && y < 540)
      this.onAction("confirm", true);
    else if (
      this.run.phase !== "playing" &&
      this.run.phase !== "title" &&
      x > 455 &&
      x < 825 &&
      y > 440 &&
      y < 506
    )
      this.onAction("confirm", true);
  }
  override update(dt: number) {
    const r = this.run,
      input = this.app.input;
    r.step(dt, {
      x: input.axis("left", "right"),
      y: input.axis("up", "down"),
      brake: input.isDown("brake"),
      sprint: input.isDown("sprint"),
    });
    if (r.phase === "playing") {
      const desired = r.vehicle
        ? 0.92 - Math.min(0.14, Math.abs(r.vehicle.motor.speed) / 2400)
        : 1.15;
      this.camera.zoom +=
        (desired - this.camera.zoom) * (1 - Math.exp(-dt * 2));
      this.camera.target = r.position;
      for (const p of this.pedestrianNodes) {
        const target = p.route[p.index],
          d = distance(p.node, target);
        if (d < 8) p.index = (p.index + 1) % 4;
        else {
          const speed =
            distance(p.node, r.position) < 100 && r.vehicle ? 80 : 26;
          p.node.x += ((target.x - p.node.x) / d) * dt * speed;
          p.node.y += ((target.y - p.node.y) / d) * dt * speed;
          p.node.rotation = Math.atan2(
            target.y - p.node.y,
            target.x - p.node.x,
          );
        }
      }
      this.soundClock -= dt;
      if (this.soundClock <= 0 && r.vehicle) {
        this.soundClock = r.heat > 0 ? 0.55 : 0.24;
        this.app.audio.play(r.heat > 0 ? "ll-siren" : "ll-engine", {
          volume:
            r.heat > 0
              ? 0.12
              : Math.min(0.09, Math.abs(r.vehicle.motor.speed) / 4000),
        });
      }
      this.skidClock -= dt;
      if (
        this.skidClock <= 0 &&
        r.vehicle &&
        input.isDown("brake") &&
        Math.abs(r.vehicle.motor.speed) > 75
      ) {
        this.skidClock = 0.07;
        const m = r.vehicle.motor,
          g = new Graphics2D(m.x, m.y);
        g.rect(-12, -16, 18, 3, 0x23323d).rect(-12, 13, 18, 3, 0x23323d);
        g.rotation = m.angle;
        this.world.add(g);
        this.marks.push({ node: g, life: 7 });
        if (this.marks.length > 100) this.marks.shift()!.node.destroy();
      }
      for (let i = this.marks.length - 1; i >= 0; i--) {
        const m = this.marks[i];
        m.life -= dt;
        m.node.alpha = Math.min(0.7, m.life / 3);
        if (m.life <= 0) {
          m.node.destroy();
          this.marks.splice(i, 1);
        }
      }
    }
    if (r.event) {
      this.app.audio.play("ll-" + r.event);
      if (r.event === "crash") this.camera.shake(5, 0.2);
      r.event = "";
    }
    if (r.phase === "lost" || r.phase === "won") this.timeScale = 0;
    this.sync();
  }
  private sync() {
    const r = this.run;
    for (const c of r.cars) {
      let node = this.carNodes.get(c);
      if (!node) {
        node = this.actors.add(carArt(c));
        this.carNodes.set(c, node);
      }
      node.x = c.motor.x;
      node.y = c.motor.y;
      node.rotation = c.motor.angle;
    }
    this.playerArt.x = r.player.x;
    this.playerArt.y = r.player.y;
    this.playerArt.rotation = r.angle;
    this.playerArt.visible = !r.vehicle;
    this.marker.x = r.objective.x;
    this.marker.y = r.objective.y;
    this.marker.scale = 1 + Math.sin(r.time * 3) * 0.08;
    this.marker.visible =
      r.phase === "playing" && r.mission !== 2 && !r.freeRoam;
  }
  get diagnostics() {
    const r = this.run;
    return {
      phase: r.phase,
      mission: r.mission,
      vehicle: !!r.vehicle,
      x: r.position.x,
      y: r.position.y,
      speed: r.vehicle?.motor.speed ?? 0,
      health: r.health,
      heat: r.heat,
      cars: r.cars.length,
      marks: this.marks.length,
      time: r.time,
    };
  }
}
class LowlineHUD extends Node2D {
  constructor(readonly game: LowlineScene) {
    super();
  }
  private map(ctx: DrawContext, large: boolean) {
    const r = this.game.run,
      x = large ? 320 : 1030,
      y = large ? 115 : 105,
      w = large ? 640 : 220,
      h = (w * SIZE.h) / SIZE.w,
      k = w / SIZE.w;
    ctx.rect(x - 12, y - 12, w + 24, h + 38, C.ink, 0.96);
    ctx.rect(x, y, w, h, 0x435f65);
    for (const rx of XS)
      ctx.rect(x + (rx - 56) * k, y + 140 * k, 112 * k, 1860 * k, 0x859397);
    for (const ry of YS)
      ctx.rect(x + 140 * k, y + (ry - 56) * k, 2188 * k, 112 * k, 0x859397);
    for (const b of buildings)
      ctx.rect(x + b.x * k, y + b.y * k, b.w * k, b.h * k, 0x304750);
    ctx.rect(x + 812 * k, y + 812 * k, 336 * k, 336 * k, 0x689380);
    for (const car of r.cars.filter((c) => c.kind === "police" && r.heat > 0))
      ctx.rect(x + car.motor.x * k - 3, y + car.motor.y * k - 3, 6, 6, C.coral);
    if (!r.freeRoam) {
      const goal = r.objective;
      ctx.rect(x + goal.x * k - 4, y + goal.y * k - 4, 8, 8, C.gold);
    }
    ctx.rect(x + r.position.x * k - 3, y + r.position.y * k - 3, 7, 7, C.mint);
    text(
      ctx,
      large ? "CITY MAP / M TO CLOSE" : "LOWLINE / M TO EXPAND",
      x,
      y + h + 9,
      10,
      C.muted,
    );
  }
  override render(ctx: DrawContext) {
    const g = this.game,
      r = g.run;
    if (r.phase === "title") {
      ctx.rect(0, 0, 1280, 720, C.ink, 0.18);
      ctx.rect(36, 35, 464, 650, C.ink, 0.96);
      ctx.rect(36, 35, 4, 650, C.gold);
      text(ctx, "KILN ORIGINAL / OPEN CITY 01", 70, 69, 12, C.gold);
      text(ctx, "LOW", 62, 112, 110, C.paper, "left", 800);
      text(ctx, "LINE", 62, 217, 110, C.paper, "left", 800);
      text(ctx, "ONE CITY. ONE LAST DISPATCH.", 70, 356, 14, C.mint);
      text(ctx, "Borrow a ride. Collect the archive.", 70, 392, 18, C.paper);
      text(
        ctx,
        "Shake the patrols. Make the waterfront.",
        70,
        421,
        18,
        C.paper,
      );
      ctx.rect(70, 483, 326, 54, C.gold);
      text(ctx, "TAKE THE WHEEL  →", 233, 501, 15, C.ink, "center", 800);
      text(ctx, "WASD  MOVE / DRIVE     E  ENTER / EXIT", 70, 572, 12, C.muted);
      text(ctx, "SPACE  HANDBRAKE     SHIFT  SPRINT", 70, 600, 12, C.muted);
      text(
        ctx,
        "ENTER TO START  ·  ORIGINAL PROCEDURAL ART",
        70,
        648,
        10,
        C.muted,
      );
      text(ctx, "THE CITY DOESN’T WAIT.", 1238, 650, 20, C.paper, "right");
      return;
    }
    ctx.rect(28, 24, 265, 64, C.ink, 0.94);
    ctx.rect(28, 24, 3, 64, C.gold);
    text(ctx, "LOWLINE", 46, 35, 23, C.paper);
    text(
      ctx,
      r.vehicle ? "AFTER HOURS / BEHIND THE WHEEL" : "AFTER HOURS / ON FOOT",
      47,
      67,
      10,
      C.muted,
    );
    ctx.rect(1008, 24, 244, 64, C.ink, 0.94);
    text(
      ctx,
      r.heat ? "PURSUIT ACTIVE" : "OFF THE RADAR",
      1027,
      37,
      11,
      r.heat ? C.coral : C.mint,
    );
    for (let i = 0; i < 3; i++)
      text(
        ctx,
        i < r.heat ? "★" : "☆",
        1190 + i * 18,
        35,
        17,
        i < r.heat ? C.coral : C.muted,
      );
    text(ctx, "$" + r.cash.toLocaleString("en-US"), 1027, 59, 16, C.paper);
    this.map(ctx, false);
    ctx.rect(28, 584, 535, 110, C.ink, 0.96);
    ctx.rect(28, 584, 4, 110, C.mint);
    text(
      ctx,
      r.freeRoam
        ? "FREE ROAM"
        : "DISPATCH / " + String(Math.min(r.mission + 1, 4)).padStart(2, "0"),
      48,
      600,
      11,
      C.mint,
    );
    text(
      ctx,
      r.freeRoam ? "Explore the city" : r.objectiveText,
      48,
      621,
      23,
      C.paper,
    );
    const detail =
      r.mission === 0
        ? "Walk to the amber coupe. Press E to enter."
        : r.mission === 1
          ? "Follow the amber marker. Press E at Records."
          : r.mission === 2
            ? "Break sightlines for 8 seconds. Keep moving."
            : "Press E at Pier 09 to complete the dispatch.";
    text(
      ctx,
      r.freeRoam ? "Drive any civilian car. H horn / R new dispatch." : detail,
      48,
      660,
      13,
      C.muted,
    );
    ctx.rect(1048, 596, 204, 98, C.ink, 0.95);
    text(
      ctx,
      r.vehicle
        ? String(Math.round(Math.abs(r.vehicle.motor.speed) * 0.28)).padStart(
            3,
            "0",
          )
        : "ON FOOT",
      1067,
      608,
      r.vehicle ? 40 : 23,
      C.paper,
    );
    text(
      ctx,
      r.vehicle
        ? "KM/H / " + (r.vehicle.motor.speed < 0 ? "R" : "D")
        : "SHIFT TO SPRINT",
      1234,
      656,
      10,
      C.muted,
      "right",
    );
    ctx.rect(1067, 678, 166, 4, 0x36515a);
    ctx.rect(
      1067,
      678,
      (166 * r.health) / 100,
      4,
      r.health < 30 ? C.coral : C.mint,
    );
    text(
      ctx,
      "WASD  MOVE / DRIVE     E  INTERACT     SPACE  DRIFT     ESC  PAUSE     H  HORN     N  MUTE",
      640,
      709,
      10,
      C.muted,
      "center",
    );
    if (r.heat) {
      ctx.rect(437, 28, 400, 43, C.ink, 0.93);
      text(
        ctx,
        r.busted > 0 ? "BLOCKED / GET MOVING" : "BREAK LINE OF SIGHT",
        637,
        37,
        12,
        r.busted > 0 ? C.coral : C.gold,
        "center",
      );
      ctx.rect(453, 59, 368, 3, 0x38535a);
      ctx.rect(
        453,
        59,
        368 * (r.busted > 0 ? r.busted / 5 : r.escape / 8),
        3,
        r.busted > 0 ? C.coral : C.mint,
      );
    }
    if (r.noticeTime > 0) {
      ctx.rect(280, 510, 720, 38, C.ink, 0.94);
      text(ctx, r.notice, 640, 522, 12, C.paper, "center");
    }
    if (!r.freeRoam && r.mission !== 2) {
      const [sx, sy] = g.camera.worldToScreen(r.objective.x, r.objective.y);
      if (sx < 50 || sx > 1000 || sy < 100 || sy > 530) {
        const x = Math.max(72, Math.min(950, sx)),
          y = Math.max(125, Math.min(480, sy));
        ctx.rect(x - 27, y - 15, 54, 30, C.gold, 0.95);
        text(
          ctx,
          Math.round(distance(r.position, r.objective) / 10) + "m",
          x,
          y - 6,
          12,
          C.ink,
          "center",
        );
      }
    }
    if (g.mapOpen) this.map(ctx, true);
    if (r.phase === "paused" || r.phase === "won" || r.phase === "lost") {
      ctx.rect(0, 0, 1280, 720, C.ink, 0.64);
      ctx.rect(405, 173, 470, 385, C.ink, 0.98);
      ctx.rect(405, 173, 470, 4, r.phase === "lost" ? C.coral : C.gold);
      text(
        ctx,
        r.phase === "won"
          ? "DELIVERY CONFIRMED"
          : r.phase === "lost"
            ? "DISPATCH INTERRUPTED"
            : "CITY ON HOLD",
        640,
        211,
        12,
        C.mint,
        "center",
      );
      text(
        ctx,
        r.phase === "won"
          ? "CLEAN GETAWAY"
          : r.phase === "lost"
            ? r.health <= 0
              ? "OUT OF ACTION"
              : "BUSTED"
            : "PAUSED",
        640,
        262,
        38,
        C.paper,
        "center",
        800,
      );
      text(
        ctx,
        r.phase === "won"
          ? "$2,400 earned. The archive is safe."
          : r.phase === "lost"
            ? "The city caught up. Try another route."
            : "Your ride will be here when you return.",
        640,
        335,
        16,
        C.muted,
        "center",
      );
      ctx.rect(455, 441, 370, 55, C.gold);
      text(
        ctx,
        r.phase === "won"
          ? "KEEP EXPLORING"
          : r.phase === "lost"
            ? "TRY AGAIN"
            : "BACK TO THE CITY",
        640,
        459,
        14,
        C.ink,
        "center",
        800,
      );
      text(
        ctx,
        "ENTER TO CONTINUE / R NEW DISPATCH",
        640,
        521,
        11,
        C.muted,
        "center",
      );
    }
  }
}
export default async function main(app: App) {
  app.input.map({
    left: ["KeyA", "ArrowLeft"],
    right: ["KeyD", "ArrowRight"],
    up: ["KeyW", "ArrowUp"],
    down: ["KeyS", "ArrowDown"],
    confirm: ["Enter"],
    interact: ["KeyE"],
    brake: ["Space"],
    sprint: ["ShiftLeft", "ShiftRight"],
    pause: ["Escape"],
    restart: ["KeyR"],
    map: ["KeyM"],
    mute: ["KeyN"],
    horn: ["KeyH"],
  });
  const a = app.audio;
  a.defineSfx("ll-start", {
    wave: "triangle",
    freq: 330,
    freqEnd: 660,
    duration: 0.12,
    release: 0.25,
    volume: 0.25,
  });
  a.defineSfx("ll-enter", {
    wave: "noise",
    freq: 180,
    duration: 0.06,
    release: 0.07,
    volume: 0.15,
    lowpass: 650,
  });
  a.defineSfx("ll-crash", {
    wave: "noise",
    freq: 180,
    freqEnd: 60,
    duration: 0.12,
    release: 0.18,
    volume: 0.25,
    lowpass: 950,
  });
  a.defineSfx("ll-engine", {
    wave: "sawtooth",
    freq: 75,
    freqEnd: 95,
    duration: 0.16,
    release: 0.12,
    volume: 0.15,
    lowpass: 320,
  });
  a.defineSfx("ll-siren", {
    wave: "sine",
    freq: 440,
    freqEnd: 660,
    duration: 0.38,
    release: 0.14,
    volume: 0.2,
  });
  a.defineSfx("ll-horn", {
    wave: "square",
    freq: 220,
    duration: 0.14,
    release: 0.06,
    volume: 0.13,
    lowpass: 800,
  });
  for (const event of ["pickup", "clear", "win"])
    a.defineSfx("ll-" + event, {
      wave: "triangle",
      freq: 440,
      freqEnd: 880,
      duration: 0.12,
      release: 0.3,
      volume: 0.2,
      repeat: 2,
      repeatGap: 0.08,
    });
  a.defineSfx("ll-lost", {
    wave: "sawtooth",
    freq: 220,
    freqEnd: 55,
    duration: 0.5,
    release: 0.3,
    volume: 0.2,
    lowpass: 650,
  });
  a.defineMood("ll-night", {
    tempo: 94,
    root: 110,
    scale: [0, 2, 3, 5, 7, 10],
    wave: "triangle",
    density: 0.25,
    pad: true,
    bass: true,
    volume: 0.17,
    lowpass: 1100,
    seed: 71,
  });
  app.scenes.change(new LowlineScene());
}
