import { ArcadeWorld2D } from "@blackiron-studio/engine/physics";
import {
  START,
  PICKUP,
  DROP,
  world,
  makeTraffic,
  makeCar,
  roadRoute,
  clearLine,
  distance,
  angleDelta,
  XS,
  YS,
  type Car,
} from "./city.ts";
export class CityRun {
  phase: "title" | "playing" | "paused" | "won" | "lost" = "title";
  player = { ...START };
  angle = 0;
  cars = makeTraffic();
  vehicle: Car | null = null;
  mission = 0;
  heat = 0;
  escape = 0;
  busted = 0;
  health = 100;
  time = 0;
  cash = 0;
  freeRoam = false;
  notice = "";
  noticeTime = 0;
  impact = 0;
  event = "";
  get position() {
    return this.vehicle?.motor ?? this.player;
  }
  get objective() {
    return this.mission === 0
      ? { x: 777, y: 1260 }
      : this.mission === 1
        ? PICKUP
        : DROP;
  }
  get objectiveText() {
    return [
      "Find the amber coupe",
      "Collect the archive",
      "Lose the patrols",
      "Deliver to the waterfront",
    ][Math.min(this.mission, 3)];
  }
  start() {
    this.phase = "playing";
    this.say("E enters a car. WASD drives. Space is the handbrake.");
  }
  say(text: string) {
    this.notice = text;
    this.noticeTime = 5;
  }
  interact() {
    if (this.phase !== "playing") return;
    if (this.mission === 1 && distance(this.position, PICKUP) < 90) {
      this.mission = 2;
      this.heat = 2;
      this.escape = 0;
      this.say(
        "ARCHIVE SECURED / Lose the patrols. Break their line of sight.",
      );
      this.event = "pickup";
      this.spawnPolice();
      return;
    }
    if (this.mission === 3 && distance(this.position, DROP) < 100) {
      this.cash += 2400;
      this.phase = "won";
      this.event = "win";
      return;
    }
    if (this.vehicle) {
      if (Math.abs(this.vehicle.motor.speed) > 45) {
        this.say("Slow down before getting out.");
        return;
      }
      const c = this.vehicle.motor;
      const candidates = [Math.PI / 2, -Math.PI / 2, Math.PI, 0].map((a) => ({
        x: c.x + Math.cos(c.angle + a) * 49,
        y: c.y + Math.sin(c.angle + a) * 49,
      }));
      const exit = candidates.find(
        (p) =>
          world.free(p.x, p.y, 10) &&
          !this.cars.some(
            (other) => other !== this.vehicle && distance(other.motor, p) < 35,
          ),
      );
      if (!exit) {
        this.say("Door blocked. Move the car into open space.");
        return;
      }
      c.stop();
      this.player = { ...exit };
      this.vehicle = null;
      this.say("On foot / E to enter a nearby car.");
      return;
    }
    const c = this.cars
      .filter(
        (c) =>
          c.kind !== "police" &&
          distance(c.motor, this.player) < 72 &&
          Math.abs(c.motor.speed) < 100,
      )
      .sort(
        (a, b) =>
          distance(a.motor, this.player) - distance(b.motor, this.player),
      )[0];
    if (!c) {
      this.say("Get closer to a car, then press E.");
      return;
    }
    if (c.kind === "traffic") {
      this.heat = Math.max(1, this.heat);
      this.spawnPolice();
      this.say("Vehicle reported. Patrol dispatched.");
    }
    c.kind = "parked";
    c.motor.stop();
    this.vehicle = c;
    if (this.mission === 0) {
      this.mission = 1;
      this.say("DISPATCH / Pick up the archive at Northstar Records.");
    }
    this.event = "enter";
  }
  spawnPolice() {
    if (this.cars.some((c) => c.kind === "police")) return;
    const p = this.position;
    for (let i = 0; i < 3; i++) {
      const options = XS.flatMap((x) => YS.map((y) => ({ x, y })))
        .filter((v) => distance(v, p) > 500)
        .sort((a, b) => distance(a, p) - distance(b, p));
      const spot = options[i * 2] ?? options[0],
        c = makeCar(spot.x, spot.y, 0, 0xc7d3cf, "police");
      this.cars.push(c);
    }
  }
  step(
    dt: number,
    input: { x: number; y: number; brake?: boolean; sprint?: boolean },
  ) {
    if (this.phase !== "playing" || dt <= 0) return;
    this.time += dt;
    this.noticeTime = Math.max(0, this.noticeTime - dt);
    this.impact = Math.max(0, this.impact - dt);
    if (this.vehicle) {
      const impact = this.vehicle.motor.step(
        dt,
        { throttle: -input.y, steer: input.x, handbrake: input.brake },
        world,
      );
      if (impact > 85 && this.impact === 0) {
        this.health = Math.max(0, this.health - (impact - 60) * 0.035);
        this.impact = 0.45;
        this.event = "crash";
      }
      this.player.x = this.vehicle.motor.x;
      this.player.y = this.vehicle.motor.y;
    } else {
      const n = Math.max(1, Math.hypot(input.x, input.y)),
        speed = input.sprint ? 155 : 105;
      world.move(
        this.player,
        (input.x / n) * speed * dt,
        (input.y / n) * speed * dt,
        10,
      );
      if (input.x || input.y) this.angle = Math.atan2(input.y, input.x);
    }
    const target = this.position;
    let seen = false,
      near = false;
    for (const c of this.cars) {
      c.cooldown = Math.max(0, c.cooldown - dt);
      if (c === this.vehicle || c.kind === "parked") continue;
      const m = c.motor;
      if (c.kind === "police") {
        if (this.heat === 0) {
          m.step(dt, { throttle: 0, steer: 0 }, world);
          continue;
        }
        const d = distance(m, target),
          visible = d < 450 && clearLine(m, target, 8);
        seen ||= visible;
        near ||= d < 67;
        if (c.cooldown === 0) {
          c.route =
            visible && clearLine(m, target)
              ? [{ x: target.x, y: target.y }]
              : roadRoute(m, target);
          c.waypoint = 0;
          c.cooldown = 0.7;
        }
      }
      let aim = c.route[c.waypoint];
      if (!aim) continue;
      if (distance(m, aim) < 55) {
        c.waypoint =
          c.kind === "traffic"
            ? (c.waypoint + 1) % c.route.length
            : Math.min(c.waypoint + 1, c.route.length - 1);
        aim = c.route[c.waypoint];
      }
      const difference = angleDelta(
        Math.atan2(aim.y - m.y, aim.x - m.x),
        m.angle,
      );
      const cap = c.kind === "police" ? 235 : 90;
      const desired = Math.abs(difference) > 0.65 ? 65 : cap;
      const blocked = this.cars.some(
        (other) =>
          other !== c &&
          distance(other.motor, m) < 62 &&
          Math.abs(
            angleDelta(
              Math.atan2(other.motor.y - m.y, other.motor.x - m.x),
              m.angle,
            ),
          ) < 0.55,
      );
      const throttle =
        (blocked || (!this.vehicle && distance(m, this.player) < 95)) &&
        c.kind === "traffic"
          ? m.speed > 5
            ? -1
            : 0
          : m.speed < desired
            ? 1
            : 0;
      m.step(
        dt,
        { throttle, steer: Math.max(-1, Math.min(1, difference * 2.4)) },
        world,
      );
      const relativeSpeed = Math.hypot(
        m.vx - (this.vehicle?.motor.vx ?? 0),
        m.vy - (this.vehicle?.motor.vy ?? 0),
      );
      if (distance(m, target) < 43 && this.impact === 0 && relativeSpeed > 65) {
        this.health = Math.max(0, this.health - 5);
        this.impact = 0.65;
        this.event = "crash";
        m.stop();
        if (this.vehicle) this.vehicle.motor.speed *= 0.5;
      }
    }
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j],
          aStatic = a.kind === "parked" && a !== this.vehicle,
          bStatic = b.kind === "parked" && b !== this.vehicle;
        if (aStatic && bStatic) continue;
        if (
          world.separate(
            a.motor,
            23,
            b.motor,
            23,
            aStatic ? 0 : bStatic ? 1 : 0.5,
          )
        ) {
          a.motor.speed *= 0.8;
          b.motor.speed *= 0.8;
        }
      }
      if (!this.vehicle) world.separate(a.motor, 23, this.player, 10, 0);
    }
    if (this.heat > 0) {
      this.escape = seen ? Math.max(0, this.escape - dt * 2) : this.escape + dt;
      this.busted =
        near && (!this.vehicle || Math.abs(this.vehicle.motor.speed) < 55)
          ? this.busted + dt
          : Math.max(0, this.busted - dt * 2);
      if (this.escape >= 8) {
        this.heat = 0;
        this.escape = 0;
        this.busted = 0;
        if (this.mission === 2) this.mission = 3;
        this.say("PURSUIT LOST / Deliver the archive to Pier 09.");
        this.event = "clear";
      }
    }
    if (this.health <= 0 || this.busted >= 5) {
      this.phase = "lost";
      this.event = "lost";
    }
  }
}
