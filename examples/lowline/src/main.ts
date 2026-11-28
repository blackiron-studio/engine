import type { App } from "@blackiron-studio/engine/app";
import { Scene, Node2D, type DrawContext } from "@blackiron-studio/engine/scene";
import { Rng } from "@blackiron-studio/engine/core";
import { CityRun } from "./game.ts";
import { SIZE, XS, YS, buildings, distance, type Car } from "./city.ts";
import { DrivePad } from "./touch.ts";
import {
  C,
  text,
  textSize,
  withTextFloor,
  buildCity,
  carArt,
  personArt,
  Beacon,
  CarLights,
  Harbour,
  HarbourGlow,
  type CarNode,
  type City,
} from "./presentation.ts";
export class LowlineScene extends Scene {
  readonly run = new CityRun();
  readonly actors = new Node2D();
  readonly skids = new Node2D();
  readonly carNodes = new Map<Car, CarNode>();
  readonly pedestrianNodes: {
    node: Node2D;
    route: { x: number; y: number }[];
    index: number;
  }[] = [];
  readonly playerArt = personArt(C.gold, 1, true);
  readonly marker = new Beacon();
  readonly pad = new DrivePad();
  readonly hud = new LowlineHUD(this);
  city!: City;
  mapOpen = false;
  private soundClock = 0;
  private skidClock = 0;
  private marks: { node: Node2D; life: number }[] = [];
  constructor() {
    super(1280, 720);
    this.name = "lowline";
  }
  override ready() {
    const city = (this.city = buildCity());
    this.world.add(city.ground);
    this.world.add(new Harbour());
    this.world.add(this.skids);
    this.world.add(this.actors);
    this.world.add(city.above);
    this.world.add(city.fountain);
    this.world.add(this.marker);
    this.world.add(city.lights);
    city.lights.add(new HarbourGlow());
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
          personArt(
            rng.pick([0xc6a281, 0x76a8a3, 0xd28580, 0x9695b4, 0xe9e4da, 0x4a5a78, 0x8fbf8a]),
            rng.int(0, 4),
          ),
        );
      node.x = route[index].x;
      node.y = route[index].y;
      this.pedestrianNodes.push({ node, route, index: (index + 1) % 4 });
    }
    this.actors.add(this.playerArt);
    this.camera.bounds = { x: 120, y: 120, w: 2300, h: 1930 };
    this.camera.snap = false;
    this.camera.zoom = 1.1;
    this.camera.follow(this.run.position, 5);
    this.ui.add(this.hud);
    this.ui.add(this.pad);
    // On phones and tablets the touch controls and touch wording show from the first frame.
    this.pad.always = this.app.screen.touch;
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
  /** The smallest tap target, in UI units, that still shows at 44 points on a touch screen; 0 elsewhere. */
  get tapSize(): number {
    const s = this.app.screen;
    return s.touch ? Math.ceil(44 / (s.pointsPerUnit * (this.ui.scaleX || 1)) - 1e-6) : 0;
  }
  /** The smallest HUD text, in UI units, that still shows at 11 points on a touch screen; 0 elsewhere. */
  get textFloor(): number {
    const s = this.app.screen;
    return s.touch ? Math.ceil(11 / (s.pointsPerUnit * (this.ui.scaleX || 1)) - 1e-6) : 0;
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
        r.touch = this.pad.active;
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
        r.say(this.pad.active ? "FREE ROAM / The city is yours. Pause for a new dispatch." : "FREE ROAM / The city is yours. R starts a new dispatch.");
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
  override onPointerDown(px: number, py: number) {
    // The engine's toUI: a screen point in the UI layer's units (the UI grows on phones).
    const { x, y } = this.toUI(px, py),
      r = this.run,
      hit = this.hud.hitAt(x, y);
    if (r.phase === "title") {
      if (hit === "start" || this.pad.active) this.onAction("confirm", true);
      return;
    }
    if (hit === "main") return this.onAction("confirm", true);
    if (hit === "restart") return this.onAction("restart", true);
    if (r.phase !== "playing" || !this.hud.adaptive) return;
    if (this.mapOpen) this.mapOpen = false;
    else if (hit === "pause") this.pause();
    else if (hit === "map") this.mapOpen = true;
  }
  override update(dt: number) {
    const r = this.run,
      input = this.app.input,
      pad = this.pad;
    pad.driving = !!r.vehicle && r.phase === "playing";
    pad.visible = r.phase === "playing" && !this.mapOpen;
    pad.action = ACTION[r.context];
    if (pad.takeAction()) r.interact();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    let y = clamp(input.axis("up", "down") + pad.sy);
    if (r.vehicle && (pad.held.gas || pad.held.brake)) y = pad.held.gas ? -1 : 1;
    r.step(dt, {
      x: clamp(input.axis("left", "right") + pad.sx),
      y,
      brake: input.isDown("brake") || pad.held.drift,
      sprint: input.isDown("sprint") || Math.hypot(pad.sx, pad.sy) > 0.92,
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
        (input.isDown("brake") || pad.held.drift) &&
        Math.abs(r.vehicle.motor.speed) > 75
      ) {
        this.skidClock = 0.07;
        const m = r.vehicle.motor,
          g = new Skid(m.x, m.y);
        g.rotation = m.angle;
        this.skids.add(g);
        this.marks.push({ node: g, life: 7 });
        if (this.marks.length > 100) this.marks.shift()!.node.destroy();
      }
      for (let i = this.marks.length - 1; i >= 0; i--) {
        const m = this.marks[i];
        m.life -= dt;
        m.node.alpha = Math.min(0.75, m.life / 3);
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
        node = this.actors.add(carArt(c, this.carNodes.size));
        this.carNodes.set(c, node);
        this.city.lights.add(new CarLights(node));
      }
      node.lit = c.kind !== "parked" || r.vehicle === c;
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
/** A tyre mark left by the handbrake. */
class Skid extends Node2D {
  override render(ctx: DrawContext) {
    ctx.sprite("ll.fx.skid", -3, -14.6, { alpha: 0.8, smooth: true });
    ctx.sprite("ll.fx.skid", -3, 14.6, { alpha: 0.8, smooth: true });
  }
}
/** A HUD card: soft shadow, deep translucent glass, a hairline border and an accent edge. */
function panel(ctx: DrawContext, x: number, y: number, w: number, h: number, accent = 0, alpha = 0.88) {
  ctx.sprite("ll.ui.shadow", x + w / 2, y + h / 2 + 5, { sx: (w + 16) / 36, sy: (h + 16) / 36, alpha: 0.55, smooth: true });
  ctx.rect(x, y, w, h, C.ink, alpha);
  ctx.sprite("ll.ui.fadeV", x, y, { ox: 0, oy: 0, sx: w / 8, sy: Math.min(h, 60) / 64, tint: 0x3a5478, alpha: 0.28, smooth: true });
  ctx.frame(x, y, w, h, 0xffffff, 0.09, 1);
  ctx.rect(x, y, w, 1, 0xffffff, 0.12);
  if (accent) ctx.rect(x, y, 3, h, accent);
}
/** The big amber call-to-action button. */
function button(ctx: DrawContext, x: number, y: number, w: number, h: number, label: string) {
  ctx.sprite("ll.ui.shadow", x + w / 2, y + h / 2 + 4, { sx: (w + 20) / 36, sy: (h + 16) / 36, alpha: 0.6, smooth: true });
  ctx.rect(x, y, w, h, C.gold);
  ctx.sprite("ll.ui.fadeV", x, y, { ox: 0, oy: 0, sx: w / 8, sy: h / 64, tint: 0xffffff, alpha: 0.35, smooth: true });
  ctx.rect(x, y + h - 2, w, 2, 0xa86a22);
  text(ctx, label, x + w / 2, y + h / 2 - 9, 15, C.ink, "center", 900);
}
function keycap(ctx: DrawContext, label: string, x: number, y: number, size = 10): number {
  const w = Math.max(18, label.length * size * 0.66 + 10);
  ctx.rect(x, y, w, size + 9, 0xffffff, 0.08);
  ctx.frame(x, y, w, size + 9, 0xffffff, 0.22, 1);
  text(ctx, label, x + w / 2, y + 4, size, C.paper, "center", 800);
  return w;
}
function hints(ctx: DrawContext, items: [string, string][], x: number, y: number, size = 10, align: "left" | "center" = "left") {
  const widths = items.map(([k, l]) => Math.max(18, k.length * size * 0.66 + 10) + 7 + ctx.measure(l, 1, 0, { family: "Arial", size, weight: 700 }) + 22);
  let cx = align === "center" ? x - widths.reduce((a, b) => a + b, 0) / 2 : x;
  items.forEach(([k, l], i) => {
    const w = keycap(ctx, k, cx, y, size);
    text(ctx, l, cx + w + 7, y + 4, size, C.muted, "left", 700);
    cx += widths[i];
  });
}
/** A view of `ctx` that offsets every positioned draw, for anchoring HUD groups to screen edges. */
function shift(ctx: DrawContext, dx: number, dy: number): DrawContext {
  if (dx === 0 && dy === 0) return ctx;
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === "sprite") return (n: string, x = 0, y = 0, o?: object) => target.sprite(n, x + dx, y + dy, o);
      if (prop === "rect") return (x: number, y: number, w: number, h: number, c: number, a?: number, add?: boolean) => target.rect(x + dx, y + dy, w, h, c, a, add);
      if (prop === "frame") return (x: number, y: number, w: number, h: number, c: number, a?: number, t?: number) => target.frame(x + dx, y + dy, w, h, c, a, t);
      if (prop === "text") return (t: string, x: number, y: number, o?: object) => target.text(t, x + dx, y + dy, o);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
const ACTION = { collect: "COLLECT", deliver: "DELIVER", exit: "EXIT", enter: "ENTER", "": "" } as const;
/** `s` broken into lines no wider than `maxW` units. */
function wrap(ctx: DrawContext, s: string, maxW: number, size: number, weight: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    const next = line ? line + " " + word : word;
    if (line && ctx.measure(next, 1, 0, { family: "Arial", size, weight }) > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
export class LowlineHUD extends Node2D {
  t = 0;
  /** Tap targets from the last frame, in UI units. */
  private hits: Hit[] = [];
  /** The tap targets drawn last frame (for tests). */
  get targets(): readonly Hit[] {
    return this.hits;
  }
  constructor(readonly game: LowlineScene) {
    super();
  }
  /**
   * Phones, tablets and windows smaller than the 1280 x 720 design get the touch layout: the map,
   * speed and health in one card top left, the bottom corners left free for the thumbs.
   */
  get adaptive(): boolean {
    const g = this.game;
    return g.pad.active || g.uiWidth < 1280 || g.uiHeight < 720;
  }
  override update(dt: number) {
    this.t += dt;
  }
  hitAt(x: number, y: number): string | undefined {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) return h.id;
    }
  }
  private hit(id: string, x: number, y: number, w: number, h: number) {
    this.hits.push({ id, x, y, w, h });
  }
  /** The city drawn `w` units wide with its top left corner at x, y. */
  private mapBody(ctx: DrawContext, x: number, y: number, w: number) {
    const r = this.game.run,
      h = (w * SIZE.h) / SIZE.w,
      k = w / SIZE.w;
    ctx.rect(x, y, w, h, 0x0f2a3c);
    ctx.rect(x + 140 * k, y + 140 * k, 2188 * k, 1868 * k, 0x2a3442);
    for (const rx of XS) ctx.rect(x + (rx - 56) * k, y + 140 * k, 112 * k, 1868 * k, 0x59657a);
    for (const ry of YS) ctx.rect(x + 140 * k, y + (ry - 56) * k, 2188 * k, 112 * k, 0x59657a);
    for (const b of buildings) ctx.rect(x + b.x * k, y + b.y * k, b.w * k, b.h * k, 0x1b222d);
    ctx.rect(x + 812 * k, y + 812 * k, 336 * k, 336 * k, 0x3f7a5c);
    const flash = Math.sin(this.t * 12) > 0;
    for (const car of r.cars.filter((c) => c.kind === "police" && r.heat > 0)) {
      ctx.sprite("ll.fx.dot", x + car.motor.x * k, y + car.motor.y * k, { sx: 0.9, sy: 0.9, tint: flash ? C.coral : 0x5a8dff, smooth: true });
    }
    if (!r.freeRoam) {
      const goal = r.objective,
        pulse = 1 + ((this.t * 1.2) % 1) * 1.6;
      ctx.sprite("__ring", x + goal.x * k, y + goal.y * k, { sx: pulse * 0.32, sy: pulse * 0.32, tint: C.gold, alpha: 1 - ((this.t * 1.2) % 1), smooth: true });
      ctx.sprite("ll.fx.dot", x + goal.x * k, y + goal.y * k, { sx: 1, sy: 1, tint: C.gold, smooth: true });
    }
    const heading = r.vehicle ? r.vehicle.motor.angle : r.angle;
    ctx.sprite("ll.ui.arrow", x + r.position.x * k, y + r.position.y * k, { rot: heading, sx: 0.85, sy: 0.85, tint: C.mint, smooth: true });
    ctx.frame(x, y, w, h, 0xffffff, 0.12, 1);
  }
  /** The desktop minimap (top right), or the large city map in the middle of the screen. */
  private map(screen: DrawContext, large: boolean) {
    const g = this.game,
      W = g.uiWidth,
      H = g.uiHeight,
      [it, ir, ib, il] = g.uiInsets,
      dx = large ? (W - 1280) / 2 : W - 1280,
      dy = large ? (H - 720) / 2 : 0,
      ctx = shift(screen, dx, dy),
      // On a screen smaller than the 1280 x 720 design the city map shrinks to fit, centred in the safe area.
      fit = large && (W < 1280 || H < 720),
      fitW = Math.min(640, W - il - ir - 60, ((H - it - ib - 90) * SIZE.w) / SIZE.h),
      w = fit ? fitW : large ? 640 : 216,
      h = (w * SIZE.h) / SIZE.w,
      x = fit ? il + (W - il - ir - w) / 2 - dx : large ? 320 : 1036,
      y = fit ? it + (H - it - ib - h - 30) / 2 - dy : large ? 115 : 106,
      touch = g.pad.active;
    panel(ctx, x - 10, y - 10, w + 20, h + 40, 0, 0.94);
    this.mapBody(ctx, x, y, w);
    text(ctx, large ? "CITY MAP" : "LOWLINE", x, y + h + 10, 10, C.paper, "left", 800);
    text(ctx, large ? (touch ? "TAP TO CLOSE" : "M  CLOSE") : "M  EXPAND", x + w, y + h + 10, 10, C.muted, "right", 700);
  }
  private stars(ctx: DrawContext, heat: number, x: number, y: number) {
    for (let i = 0; i < 3; i++) {
      const on = i < heat,
        flash = on && Math.sin(this.t * 8 + i) > 0;
      if (on) ctx.sprite("ll.fx.glow", x + i * 22, y, { sx: 0.5, sy: 0.5, tint: C.coral, alpha: flash ? 0.6 : 0.3, additive: true, smooth: true });
      ctx.sprite(on ? "ll.ui.star" : "ll.ui.starline", x + i * 22, y, { tint: on ? (flash ? 0xffb0a0 : C.coral) : 0x5d6f80, smooth: true });
    }
  }
  private title(screen: DrawContext) {
    const g = this.game,
      W = g.uiWidth,
      H = g.uiHeight,
      touch = g.pad.active,
      [, ir, ib, il] = g.uiInsets;
    screen.sprite("ll.ui.fadeH", 0, 0, { ox: 0, oy: 0, sx: 820 / 64, sy: H / 8, tint: C.ink, alpha: 0.92, smooth: true });
    screen.sprite("ll.ui.fadeV", 0, H, { ox: 0, oy: 0, sx: W / 8, sy: -220 / 64, tint: C.ink, alpha: 0.85, smooth: true });
    screen.sprite("ll.ui.fadeV", 0, 0, { ox: 0, oy: 0, sx: W / 8, sy: 120 / 64, tint: C.ink, alpha: 0.6, smooth: true });
    if (this.adaptive && H < 600) return this.titleCompact(screen);
    const dy = (H - 720) / 2,
      ctx = shift(screen, il, dy);
    panel(ctx, 36, 35, 464, 650, 0, 0.72);
    ctx.rect(36, 35, 4, 650, C.gold);
    ctx.sprite("ll.fx.glow", 40, 360, { sx: 0.4, sy: 10, tint: C.gold, alpha: 0.25, additive: true, smooth: true });
    text(ctx, "BLACKIRON ORIGINAL", 70, 69, 11, C.gold, "left", 800);
    text(ctx, "OPEN CITY  01", 466, 69, 11, C.muted, "right", 800);
    ctx.rect(70, 92, 396, 1, 0xffffff, 0.14);
    // The wordmark: two heavy lines, the second picked out in amber with a neon underline.
    text(ctx, "LOW", 64, 114, 112, 0x000000, "left", 900, 0.35);
    text(ctx, "LOW", 62, 110, 112, C.paper, "left", 900);
    text(ctx, "LINE", 64, 219, 112, 0x000000, "left", 900, 0.35);
    text(ctx, "LINE", 62, 215, 112, C.gold, "left", 900);
    ctx.sprite("ll.fx.glow", 190, 336, { sx: 5, sy: 0.35, tint: C.pink, alpha: 0.55, additive: true, smooth: true });
    ctx.rect(70, 334, 244, 3, C.pink);
    ctx.rect(322, 334, 18, 3, C.cyan);
    text(ctx, "ONE CITY. ONE LAST DISPATCH.", 70, 360, 13, C.mint, "left", 800);
    text(ctx, "Borrow a ride. Collect the archive.", 70, 394, 18, C.paper, "left", 600);
    text(ctx, "Shake the patrols. Make the waterfront.", 70, 423, 18, C.paper, "left", 600);
    const pulse = 0.5 + Math.sin(this.t * 3) * 0.5;
    ctx.sprite("ll.ui.shadow", 233, 516, { sx: 346 / 36, sy: 70 / 36, alpha: 0.6, smooth: true });
    ctx.sprite("ll.fx.glow", 233, 510, { sx: 6.5, sy: 1.6, tint: C.gold, alpha: 0.15 + pulse * 0.15, additive: true, smooth: true });
    ctx.rect(70, 483, 326, 54, C.gold);
    ctx.sprite("ll.ui.fadeV", 70, 483, { ox: 0, oy: 0, sx: 326 / 8, sy: 54 / 64, tint: 0xffffff, alpha: 0.35, smooth: true });
    ctx.rect(70, 535, 326, 2, 0xa86a22);
    text(ctx, "TAKE THE WHEEL", 214, 502, 16, C.ink, "center", 900);
    text(ctx, "→", 360 + pulse * 4, 499, 20, C.ink, "center", 900);
    this.hit("start", il + 70, dy + 483, 326, 54);
    if (touch) {
      text(ctx, "LEFT THUMB STEERS  ·  RIGHT THUMB DRIVES", 70, 572, 11, C.muted, "left", 800);
      text(ctx, "GAS, BRAKE AND DRIFT ON THE RIGHT", 70, 598, 11, C.muted, "left", 800);
    } else {
      hints(ctx, [["WASD", "MOVE / DRIVE"], ["E", "ENTER / EXIT"]], 70, 568, 10);
      hints(ctx, [["SPACE", "HANDBRAKE"], ["SHIFT", "SPRINT"]], 70, 598, 10);
    }
    ctx.rect(70, 636, 396, 1, 0xffffff, 0.1);
    text(ctx, touch ? "TAP TO START" : "PRESS ENTER TO START", 70, 650, 10, C.paper, "left", 800, 0.5 + pulse * 0.5);
    text(ctx, "ORIGINAL PROCEDURAL ART", 466, 650, 10, C.muted, "right", 700);
    const corner = shift(screen, W - 1280 - ir, H - 720 - ib);
    text(corner, "THE CITY DOESN’T WAIT.", 1240, 640, 24, 0x000000, "right", 900, 0.4);
    text(corner, "THE CITY DOESN’T WAIT.", 1238, 638, 24, C.paper, "right", 900);
    text(corner, "NORTH QUAY  ·  23:47  ·  14°C", 1238, 672, 11, C.muted, "right", 800);
  }
  /** The title on a short screen (a phone held sideways): the same card, packed to fit. */
  private titleCompact(screen: DrawContext) {
    const g = this.game,
      W = g.uiWidth,
      H = g.uiHeight,
      touch = g.pad.active,
      [it, ir, ib, il] = g.uiInsets,
      tap = Math.max(54, g.tapSize),
      x = 20,
      pw = 440,
      L = x + 30,
      linesY = 244,
      buttonY = linesY + 2 * 26 + 14,
      helpY = buttonY + tap + 16,
      room = H - it - ib - 20,
      ph = Math.min(room, helpY + 32),
      top = it + Math.max(10, (H - it - ib - ph) / 2),
      ctx = shift(screen, il, top);
    panel(ctx, x, 0, pw, ph, 0, 0.72);
    ctx.rect(x, 0, 4, ph, C.gold);
    ctx.sprite("ll.fx.glow", x + 4, ph / 2, { sx: 0.4, sy: ph / 64, tint: C.gold, alpha: 0.25, additive: true, smooth: true });
    text(ctx, "BLACKIRON ORIGINAL", L, 18, 11, C.gold, "left", 800);
    text(ctx, "OPEN CITY  01", x + pw - 30, 18, 11, C.muted, "right", 800);
    ctx.rect(L, 42, pw - 60, 1, 0xffffff, 0.14);
    text(ctx, "LOW", L - 4, 53, 72, 0x000000, "left", 900, 0.35);
    text(ctx, "LOW", L - 6, 50, 72, C.paper, "left", 900);
    text(ctx, "LINE", L - 4, 121, 72, 0x000000, "left", 900, 0.35);
    text(ctx, "LINE", L - 6, 118, 72, C.gold, "left", 900);
    ctx.sprite("ll.fx.glow", L + 100, 199, { sx: 4, sy: 0.3, tint: C.pink, alpha: 0.55, additive: true, smooth: true });
    ctx.rect(L, 198, 200, 3, C.pink);
    ctx.rect(L + 208, 198, 16, 3, C.cyan);
    text(ctx, "ONE CITY. ONE LAST DISPATCH.", L, 216, 13, C.mint, "left", 800);
    text(ctx, "Borrow a ride. Collect the archive.", L, linesY, 18, C.paper, "left", 600);
    text(ctx, "Shake the patrols. Make the waterfront.", L, linesY + 26, 18, C.paper, "left", 600);
    const pulse = 0.5 + Math.sin(this.t * 3) * 0.5;
    ctx.sprite("ll.fx.glow", L + 170, buttonY + tap / 2, { sx: 6.5, sy: 1.6, tint: C.gold, alpha: 0.15 + pulse * 0.15, additive: true, smooth: true });
    button(ctx, L, buttonY, 340, tap, "TAKE THE WHEEL");
    text(ctx, "→", L + 300 + pulse * 4, buttonY + tap / 2 - 11, 20, C.ink, "center", 900);
    this.hit("start", il + L, top + buttonY, 340, tap);
    if (touch) text(ctx, "LEFT THUMB STEERS  ·  RIGHT THUMB DRIVES", L, helpY, 11, C.muted, "left", 800);
    else hints(ctx, [["WASD", "DRIVE"], ["E", "ENTER"], ["SPACE", "BRAKE"]], L, helpY, 10);
    // The tagline, only where it clears the card.
    const right = W - ir - 24,
      size = 22,
      tw = screen.measure("THE CITY DOESN’T WAIT.", 1, 0, { family: "Arial", size, weight: 900 });
    if (right - tw > il + x + pw + 24) {
      const by = H - ib - 24 - textSize(11);
      text(screen, "THE CITY DOESN’T WAIT.", right + 2, by - 32, size, 0x000000, "right", 900, 0.4);
      text(screen, "THE CITY DOESN’T WAIT.", right, by - 34, size, C.paper, "right", 900);
      text(screen, "NORTH QUAY  ·  23:47  ·  14°C", right, by, 11, C.muted, "right", 800);
    }
  }
  override render(screen: DrawContext) {
    this.hits = [];
    withTextFloor(this.game.textFloor, () => this.draw(screen));
    // The HUD draws its own buttons; report them so `blackiron screens` measures them too.
    for (const h of this.hits) this.game.reportTarget(h.id, h.x, h.y, h.w, h.h);
    // The stick never steals a touch aimed at the HUD.
    this.game.pad.blocked = this.hits;
  }
  private draw(screen: DrawContext) {
    const g = this.game,
      r = g.run,
      W = g.uiWidth,
      H = g.uiHeight;
    // A soft vignette frame keeps the HUD legible over bright streets.
    screen.sprite("ll.ui.fadeV", 0, 0, { ox: 0, oy: 0, sx: W / 8, sy: 130 / 64, tint: 0x050a14, alpha: 0.45, smooth: true });
    screen.sprite("ll.ui.fadeV", 0, H, { ox: 0, oy: 0, sx: W / 8, sy: -170 / 64, tint: 0x050a14, alpha: 0.55, smooth: true });
    if (r.phase === "title") return this.title(screen);
    if (this.adaptive) return this.touchHud(screen);
    // The HUD is designed at 1280 x 720; each group is anchored to its own screen edge.
    const ctx = screen,
      tr = shift(screen, W - 1280, 0),
      tc = shift(screen, (W - 1280) / 2, 0),
      bl = shift(screen, 0, H - 720),
      br = shift(screen, W - 1280, H - 720),
      bc = shift(screen, (W - 1280) / 2, H - 720),
      cc = shift(screen, (W - 1280) / 2, (H - 720) / 2);
    // Brand and status.
    panel(ctx, 28, 24, 265, 64, C.gold);
    text(ctx, "LOWLINE", 46, 34, 24, C.paper, "left", 900);
    ctx.rect(157, 41, 1, 14, 0xffffff, 0.2);
    text(ctx, "23:47", 168, 39, 13, C.gold, "left", 800);
    text(ctx, r.vehicle ? "AFTER HOURS  /  BEHIND THE WHEEL" : "AFTER HOURS  /  ON FOOT", 47, 67, 10, C.muted, "left", 700);
    // Wanted level and cash.
    panel(tr, 1008, 24, 244, 64, r.heat ? C.coral : C.mint);
    text(tr, r.heat ? "PURSUIT ACTIVE" : "OFF THE RADAR", 1026, 36, 11, r.heat ? C.coral : C.mint, "left", 800);
    this.stars(tr, r.heat, 1188, 44);
    text(tr, "$" + r.cash.toLocaleString("en-US"), 1026, 56, 20, C.paper, "left", 900);
    this.map(screen, false);
    // Dispatch card.
    panel(bl, 28, 584, 535, 110, C.mint);
    text(bl, r.freeRoam ? "FREE ROAM" : "DISPATCH  /  " + String(Math.min(r.mission + 1, 4)).padStart(2, "0"), 48, 600, 11, C.mint, "left", 800);
    if (!r.freeRoam)
      for (let i = 0; i < 4; i++) bl.rect(470 + i * 20, 604, 14, 4, i < r.mission ? C.mint : i === r.mission ? C.gold : 0x33465a);
    text(bl, r.freeRoam ? "Explore the city" : r.objectiveText, 48, 621, 24, C.paper, "left", 800);
    text(bl, this.detail(false), 48, 662, 13, C.muted, "left", 600);
    // Speedometer.
    panel(br, 1048, 560, 204, 134);
    const speed = r.vehicle ? Math.abs(r.vehicle.motor.speed) * 0.28 : 0,
      frac = Math.min(1, speed / 90),
      cx = 1150,
      cy = 618;
    br.sprite("ll.ui.gauge", cx, cy, { sx: 0.88, sy: 0.88, alpha: 0.9, smooth: true });
    const segs = 30;
    for (let i = 0; i < segs; i++) {
      const a = Math.PI * 0.75 + (Math.PI * 1.5 * (i + 0.5)) / segs,
        on = i / segs < frac;
      br.sprite("ll.ui.seg", cx + Math.cos(a) * 49, cy + Math.sin(a) * 49, { rot: a + Math.PI / 2, sx: 0.55, sy: 0.6, tint: on ? (i / segs > 0.8 ? C.coral : C.gold) : 0x2a3a50, alpha: on ? 1 : 0.8, smooth: true });
    }
    if (frac > 0) {
      const na = Math.PI * 0.75 + Math.PI * 1.5 * frac;
      br.sprite("ll.fx.glow", cx + Math.cos(na) * 49, cy + Math.sin(na) * 49, { sx: 0.4, sy: 0.4, tint: C.gold, alpha: 0.8, additive: true, smooth: true });
    }
    text(br, r.vehicle ? String(Math.round(speed)).padStart(3, "0") : "--", cx, cy - 16, 30, C.paper, "center", 900);
    text(br, r.vehicle ? "KM/H  " + (r.vehicle.motor.speed < 0 ? "R" : "D") : "ON FOOT", cx, cy + 22, 9, C.muted, "center", 800);
    br.rect(1066, 682, 168, 4, 0x26364a);
    br.rect(1066, 682, (168 * r.health) / 100, 4, r.health < 30 ? C.coral : C.mint);
    text(br, "HP", 1066, 668, 9, C.muted, "left", 800);
    text(br, String(Math.round(r.health)), 1234, 668, 9, C.paper, "right", 800);
    hints(bc, [["WASD", "DRIVE"], ["E", "INTERACT"], ["SPACE", "DRIFT"], ["ESC", "PAUSE"], ["H", "HORN"], ["N", "MUTE"]], 805, 700, 9, "center");
    if (r.heat) {
      panel(tc, 437, 24, 400, 50, r.busted > 0 ? C.coral : C.gold);
      text(tc, r.busted > 0 ? "BLOCKED  /  GET MOVING" : "BREAK LINE OF SIGHT", 637, 34, 12, r.busted > 0 ? C.coral : C.gold, "center", 800);
      tc.rect(457, 58, 360, 4, 0x26364a);
      tc.rect(457, 58, 360 * (r.busted > 0 ? r.busted / 5 : r.escape / 8), 4, r.busted > 0 ? C.coral : C.mint);
      this.sirens(screen, W, H);
    }
    if (r.noticeTime > 0) {
      const a = Math.min(1, r.noticeTime * 2);
      bc.sprite("ll.ui.shadow", 640, 533, { sx: 740 / 36, sy: 50 / 36, alpha: 0.5 * a, smooth: true });
      bc.rect(280, 512, 720, 40, C.ink, 0.9 * a);
      bc.rect(280, 512, 720, 1, C.gold, 0.6 * a);
      text(bc, r.notice, 640, 525, 13, C.paper, "center", 700, a);
    }
    if (!r.freeRoam && r.mission !== 2) {
      const { x: sx, y: sy } = g.toUI(...g.camera.worldToScreen(r.objective.x, r.objective.y));
      if (sx < 50 || sx > W - 280 || sy < 100 || sy > H - 190) this.pointer(ctx, sx, sy, Math.max(72, Math.min(W - 330, sx)), Math.max(125, Math.min(H - 240, sy)));
    }
    if (g.mapOpen) this.map(ctx, true);
    if (r.phase === "paused" || r.phase === "won" || r.phase === "lost") {
      this.modal(screen, cc);
      cc.sprite("ll.ui.shadow", 640, 474, { sx: 390 / 36, sy: 70 / 36, alpha: 0.6, smooth: true });
      cc.rect(455, 441, 370, 55, C.gold);
      cc.sprite("ll.ui.fadeV", 455, 441, { ox: 0, oy: 0, sx: 370 / 8, sy: 55 / 64, tint: 0xffffff, alpha: 0.35, smooth: true });
      cc.rect(455, 494, 370, 2, 0xa86a22);
      text(cc, r.phase === "won" ? "KEEP EXPLORING" : r.phase === "lost" ? "TRY AGAIN" : "BACK TO THE CITY", 640, 459, 15, C.ink, "center", 900);
      this.hit("main", (W - 1280) / 2 + 455, (H - 720) / 2 + 441, 370, 55);
      hints(cc, [["ENTER", "CONTINUE"], ["R", "NEW DISPATCH"]], 640, 516, 10, "center");
    }
  }
  /** What to do next, in the words of the controls in hand. */
  private detail(touch: boolean): string {
    const r = this.game.run;
    if (r.freeRoam) return touch ? "Drive any civilian car. Pause for a new dispatch." : "Drive any civilian car. H horn / R new dispatch.";
    return r.mission === 0
      ? touch
        ? "Walk to the amber coupe and tap ENTER."
        : "Walk to the amber coupe. Press E to enter."
      : r.mission === 1
        ? touch
          ? "Follow the amber marker. Tap COLLECT at Records."
          : "Follow the amber marker. Press E at Records."
        : r.mission === 2
          ? "Break sightlines for 8 seconds. Keep moving."
          : touch
            ? "Tap DELIVER at Pier 09 to finish the dispatch."
            : "Press E at Pier 09 to complete the dispatch.";
  }
  /** Red and blue light down both screen edges while the patrols are out. */
  private sirens(screen: DrawContext, W: number, H: number) {
    const flash = Math.sin(this.t * 10) > 0;
    screen.sprite("ll.fx.glow", 0, 0, { ox: 0, oy: 0, sx: 4, sy: H / 32, tint: flash ? 0xff2030 : 0x2050ff, alpha: 0.18, additive: true, smooth: true });
    screen.sprite("ll.fx.glow", W, 0, { ox: 64, oy: 0, sx: 4, sy: H / 32, tint: flash ? 0x2050ff : 0xff2030, alpha: 0.18, additive: true, smooth: true });
  }
  /** The distance badge at x, y pointing at an objective that is off screen at sx, sy. */
  private pointer(ctx: DrawContext, sx: number, sy: number, x: number, y: number) {
    const r = this.game.run,
      a = Math.atan2(sy - y, sx - x);
    ctx.sprite("ll.ui.shadow", x, y + 3, { sx: 70 / 36, sy: 40 / 36, alpha: 0.5, smooth: true });
    ctx.rect(x - 30, y - 15, 60, 30, C.gold, 0.96);
    ctx.sprite("ll.ui.arrow", x + Math.cos(a) * 40, y + Math.sin(a) * 26, { rot: a, tint: C.gold, smooth: true });
    text(ctx, Math.round(distance(r.position, r.objective) / 10) + "m", x, y - 7, 13, C.ink, "center", 900);
  }
  /** The pause / won / lost card down to its one-line summary. */
  private modal(screen: DrawContext, cc: DrawContext) {
    const g = this.game,
      r = g.run,
      accent = r.phase === "lost" ? C.coral : C.gold;
    screen.rect(0, 0, g.uiWidth, g.uiHeight, 0x050a14, 0.62);
    panel(cc, 405, 173, 470, 385, 0, 0.96);
    cc.rect(405, 173, 470, 4, accent);
    cc.sprite("ll.fx.glow", 640, 175, { sx: 6, sy: 0.6, tint: accent, alpha: 0.35, additive: true, smooth: true });
    text(cc, r.phase === "won" ? "DELIVERY CONFIRMED" : r.phase === "lost" ? "DISPATCH INTERRUPTED" : "CITY ON HOLD", 640, 211, 12, C.mint, "center", 800);
    const head = r.phase === "won" ? "CLEAN GETAWAY" : r.phase === "lost" ? (r.health <= 0 ? "OUT OF ACTION" : "BUSTED") : "PAUSED";
    text(cc, head, 642, 264, 44, 0x000000, "center", 900, 0.4);
    text(cc, head, 640, 260, 44, C.paper, "center", 900);
    cc.rect(590, 322, 100, 2, accent);
    text(cc, r.phase === "won" ? "$2,400 earned. The archive is safe." : r.phase === "lost" ? "The city caught up. Try another route." : "Your ride will be here when you return.", 640, 343, 16, C.muted, "center", 600);
  }
  /** The HUD for thumbs: everything along the top, the bottom corners left to the stick and pedals. */
  private touchHud(screen: DrawContext) {
    const g = this.game,
      r = g.run,
      W = g.uiWidth,
      H = g.uiHeight,
      touch = g.pad.active,
      tap = g.tapSize,
      [it, ir, ib, il] = g.uiInsets,
      compact = H < 600,
      m = compact ? 16 : 28,
      top = it + (compact ? 16 : 24),
      small = textSize(9);
    // One instrument card top left: the map, speed and health. Tap it for the city map.
    const mapW = compact ? 150 : 216,
      mapH = (mapW * SIZE.h) / SIZE.w,
      cx = il + m,
      cw = mapW + 20,
      rowY = top + 10 + mapH + 9,
      hpY = rowY + 31,
      ch = hpY + small + 9 - top,
      speed = r.vehicle ? Math.abs(r.vehicle.motor.speed) * 0.28 : 0;
    panel(screen, cx, top, cw, ch, 0, 0.94);
    this.mapBody(screen, cx + 10, top + 10, mapW);
    if (r.vehicle) {
      text(screen, String(Math.round(speed)).padStart(3, "0"), cx + 10, rowY, 24, C.paper, "left", 900);
      text(screen, "KM/H  " + (r.vehicle.motor.speed < 0 ? "R" : "D"), cx + cw - 10, rowY + 22 - small, 9, C.muted, "right", 800);
    } else text(screen, "ON FOOT", cx + 10, rowY + 5, 13, C.paper, "left", 800);
    const hp = "HP " + Math.round(r.health),
      bar = cx + 10 + screen.measure("HP 100", 1, 0, { family: "Arial", size: small, weight: 800 }) + 8,
      barW = cx + cw - 10 - bar;
    text(screen, hp, cx + 10, hpY, 9, C.muted, "left", 800);
    screen.rect(bar, hpY + small / 2 - 2, barW, 4, 0x26364a);
    screen.rect(bar, hpY + small / 2 - 2, (barW * r.health) / 100, 4, r.health < 30 ? C.coral : C.mint);
    this.hit("map", cx, top, cw, ch);
    // Pause.
    const px = cx + cw + 10,
      ps = Math.max(56, tap);
    panel(screen, px, top, ps, ps, C.gold);
    screen.rect(px + ps / 2 - 8, top + ps / 2 - 10, 6, 20, C.gold);
    screen.rect(px + ps / 2 + 4, top + ps / 2 - 10, 6, 20, C.gold);
    this.hit("pause", px, top, ps, ps);
    // Wanted level and cash, top right.
    const kx = W - ir - m - 244;
    panel(screen, kx, top, 244, 64, r.heat ? C.coral : C.mint);
    text(screen, r.heat ? "PURSUIT ACTIVE" : "OFF THE RADAR", kx + 18, top + 10, 11, r.heat ? C.coral : C.mint, "left", 800);
    this.stars(screen, r.heat, kx + 180, top + 20);
    text(screen, "$" + r.cash.toLocaleString("en-US"), kx + 18, top + 31, 20, C.paper, "left", 900);
    // Dispatch card, beside the map and short of the action button.
    const dx = px,
      dy = top + Math.max(64, ps) + 8,
      dw = Math.min(535, W - ir - (touch ? 176 : m) - dx),
      dh = compact ? 84 : 110,
      labelY = dy + (compact ? 10 : 16);
    panel(screen, dx, dy, dw, dh, C.mint);
    text(screen, r.freeRoam ? "FREE ROAM" : "DISPATCH  /  " + String(Math.min(r.mission + 1, 4)).padStart(2, "0"), dx + 20, labelY, 11, C.mint, "left", 800);
    if (!r.freeRoam)
      for (let i = 0; i < 4; i++) screen.rect(dx + dw - 22 - (4 - i) * 20, labelY + 5, 14, 4, i < r.mission ? C.mint : i === r.mission ? C.gold : 0x33465a);
    text(screen, r.freeRoam ? "Explore the city" : r.objectiveText, dx + 20, dy + (compact ? 29 : 37), compact ? 20 : 24, C.paper, "left", 800);
    text(screen, this.detail(touch), dx + 20, dy + (compact ? 58 : 78), 13, C.muted, "left", 600);
    // Pursuit bar: between pause and cash where there is room, else under the dispatch card.
    if (r.heat) {
      const left = px + ps + 10,
        right = kx - 10,
        fits = right - left >= 220,
        bw = fits ? Math.min(400, right - left) : dw,
        bx = fits ? left + (right - left - bw) / 2 : dx,
        by = fits ? top : dy + dh + 8,
        color = r.busted > 0 ? C.coral : C.gold;
      panel(screen, bx, by, bw, 50, color);
      text(screen, r.busted > 0 ? "BLOCKED  /  GET MOVING" : "BREAK LINE OF SIGHT", bx + bw / 2, by + 9, 12, color, "center", 800);
      screen.rect(bx + 20, by + 36, bw - 40, 4, 0x26364a);
      screen.rect(bx + 20, by + 36, (bw - 40) * (r.busted > 0 ? r.busted / 5 : r.escape / 8), 4, r.busted > 0 ? C.coral : C.mint);
      this.sirens(screen, W, H);
    }
    // Notices sit low between the thumbs, wrapped to the room there.
    if (r.noticeTime > 0) {
      const a = Math.min(1, r.noticeTime * 2),
        left = il + (touch ? 240 : m),
        right = W - ir - (touch ? 300 : m),
        nw = Math.min(620, right - left),
        size = textSize(13),
        cut = r.notice.indexOf(" / "),
        head = cut < 0 ? "" : r.notice.slice(0, cut),
        body = wrap(screen, cut < 0 ? r.notice : r.notice.slice(cut + 3), nw - 32, size, 700),
        lines = head ? [head, ...body] : body,
        lh = size + 5,
        nh = lines.length * lh + 17,
        nx = left + (right - left - nw) / 2,
        ny = H - ib - 14 - nh;
      screen.sprite("ll.ui.shadow", nx + nw / 2, ny + nh / 2 + 1, { sx: (nw + 20) / 36, sy: (nh + 10) / 36, alpha: 0.5 * a, smooth: true });
      screen.rect(nx, ny, nw, nh, C.ink, 0.9 * a);
      screen.rect(nx, ny, nw, 1, C.gold, 0.6 * a);
      lines.forEach((line, i) => text(screen, line, nx + nw / 2, ny + 11 + i * lh, 13, head && i === 0 ? C.gold : C.paper, "center", head && i === 0 ? 800 : 700, a));
    }
    // The objective badge keeps to the open middle of the screen.
    if (!r.freeRoam && r.mission !== 2) {
      const { x: sx, y: sy } = g.toUI(...g.camera.worldToScreen(r.objective.x, r.objective.y)),
        x0 = cx + cw + 50,
        x1 = W - ir - (touch ? 320 : m + 50),
        x = Math.max(x0, Math.min(x1, sx)),
        // Under the dispatch card, or under the top row where the card has ended (tablets).
        y0 = x < dx + dw + 50 ? dy + dh + 40 : top + 64 + 40,
        y1 = H - ib - 130;
      if (sx < x0 - 25 || sx > x1 + 25 || sy < y0 - 25 || sy > y1 + 25) this.pointer(screen, sx, sy, x, Math.max(y0, Math.min(y1, sy)));
    }
    if (g.mapOpen) {
      screen.rect(0, 0, W, H, 0x050a14, 0.7);
      this.map(screen, true);
    }
    if (r.phase === "paused" || r.phase === "won" || r.phase === "lost") {
      // Centred in the safe area, with buttons a finger can hit in place of the key hints.
      const ox = (W - 1280) / 2,
        oy = it + (H - it - ib - 720) / 2,
        cc = shift(screen, ox, oy),
        again = r.phase !== "lost",
        bh = Math.max(55, tap),
        by = again ? 400 : 430;
      this.modal(screen, cc);
      button(cc, 455, by, 370, bh, r.phase === "won" ? "KEEP EXPLORING" : r.phase === "lost" ? "TRY AGAIN" : "BACK TO THE CITY");
      this.hit("main", ox + 455, oy + by, 370, bh);
      if (again) {
        const sy = by + bh + 10,
          sh = Math.max(40, tap);
        cc.rect(455, sy, 370, sh, 0xffffff, 0.08);
        cc.frame(455, sy, 370, sh, 0xffffff, 0.3, 1);
        text(cc, "NEW DISPATCH", 640, sy + sh / 2 - textSize(13) / 2 - 1, 13, C.paper, "center", 900);
        this.hit("restart", ox + 455, oy + sy, 370, sh);
      }
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
