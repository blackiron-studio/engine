import { moveGroundCircle } from "../../../src/three/ground.ts";

const MOVEMENT_BOUNDS = { minX: -11.6, maxX: 11.6, minZ: -11.6, maxZ: 11.6 };

export const CORES = [
  [-8, -7],
  [7, -8],
  [-9, 6],
  [9, 5],
  [0, -10],
  [5, 0],
] as const;
export const OBSTACLES = [
  { x: -5, z: -3, w: 2, d: 2 },
  { x: 5, z: -4, w: 2, d: 2 },
  { x: -6, z: 7, w: 2, d: 2 },
  { x: 7, z: 8, w: 2, d: 2 },
];
export interface SalvageState {
  x: number;
  y: number;
  z: number;
  vy: number;
  collected: boolean[];
  energy: number;
  invulnerable: number;
  time: number;
  won: boolean;
  jumps: number;
  dashRemaining: number;
  dashCooldown: number;
  facingX: number;
  facingZ: number;
  /** Direction locked when the current dash began. */
  dashX: number;
  dashZ: number;
}

export const SALVAGE_DASH = { duration: 0.16, cooldown: 1.7, speed: 16, invulnerability: 0.23 } as const;
export interface SalvageStepOptions {
  /** A dash press edge. Consumed once, including when a long step is subdivided. */
  dash?: boolean;
}
export function createSalvage(): SalvageState {
  return {
    x: 0,
    y: 0,
    z: 6,
    vy: 0,
    collected: CORES.map(() => false),
    energy: 3,
    invulnerable: 0,
    time: 0,
    won: false,
    jumps: 0,
    dashRemaining: 0,
    dashCooldown: 0,
    facingX: 0,
    facingZ: 1,
    dashX: 0,
    dashZ: 1,
  };
}
export function stepSalvage(
  s: SalvageState,
  dx: number,
  dz: number,
  jump: boolean,
  dt: number,
  options: SalvageStepOptions = {},
): { collected: number[]; hurt: boolean; won: boolean; dashed: boolean } {
  const events = { collected: [] as number[], hurt: false, won: false, dashed: false };
  if (s.won || !Number.isFinite(dt) || dt <= 0) return events;
  // Bound the gravity/gameplay integration when driven outside the App. Ground collision
  // itself is continuous and does not rely on these substeps for dash safety.
  if (dt > 1 / 60 + 0.00001) {
    let remaining = Math.min(dt, 0.25);
    let dash = options.dash;
    while (remaining > 1e-8) {
      const h = Math.min(remaining, 1 / 60),
        e = stepSalvage(s, dx, dz, jump, h, { dash });
      events.collected.push(...e.collected);
      events.hurt ||= e.hurt;
      events.won ||= e.won;
      events.dashed ||= e.dashed;
      remaining -= h;
      jump = false;
      dash = false;
    }
    return events;
  }
  s.time += dt;
  dx = Number.isFinite(dx) ? dx : 0;
  dz = Number.isFinite(dz) ? dz : 0;
  const length = Math.hypot(dx, dz);
  if (length > 1) {
    dx /= length;
    dz /= length;
  }
  if (length > 1e-8) {
    s.facingX = dx / Math.hypot(dx, dz);
    s.facingZ = dz / Math.hypot(dx, dz);
  }
  if (options.dash && s.dashCooldown <= 1e-9 && s.dashRemaining <= 1e-9) {
    s.dashRemaining = SALVAGE_DASH.duration;
    s.dashCooldown = SALVAGE_DASH.cooldown;
    s.dashX = s.facingX;
    s.dashZ = s.facingZ;
    s.invulnerable = Math.max(s.invulnerable, SALVAGE_DASH.invulnerability);
    events.dashed = true;
  }
  s.invulnerable = Math.max(0, s.invulnerable - dt);
  s.dashCooldown = Math.max(0, s.dashCooldown - dt);
  const radius = 0.38,
    speed = 5.4;
  const bounds = MOVEMENT_BOUNDS;
  const dashTime = Math.min(dt, s.dashRemaining);
  if (dashTime > 0) moveGroundCircle(s, radius, s.dashX * SALVAGE_DASH.speed * dashTime, s.dashZ * SALVAGE_DASH.speed * dashTime, OBSTACLES, { bounds });
  s.dashRemaining = Math.max(0, s.dashRemaining - dt);
  const walkTime = dt - dashTime;
  if (walkTime > 0) moveGroundCircle(s, radius, dx * speed * walkTime, dz * speed * walkTime, OBSTACLES, { bounds });
  if (jump && s.y <= 0.001) {
    s.vy = 6;
    s.jumps++;
  }
  s.vy -= 17 * dt;
  s.y = Math.max(0, s.y + s.vy * dt);
  if (!s.y) s.vy = 0;
  for (let i = 0; i < CORES.length; i++) {
    const p = CORES[i];
    if (!s.collected[i] && Math.hypot(s.x - p[0], s.z - p[1]) < 1) {
      s.collected[i] = true;
      events.collected.push(i);
    }
  }
  for (let i = 0; i < 2; i++) {
    const d = dronePosition(s.time, i);
    if (
      s.invulnerable <= 0 &&
      s.y < 0.9 &&
      Math.hypot(s.x - d.x, s.z - d.z) < 0.85
    ) {
      s.energy--;
      s.invulnerable = 2;
      events.hurt = true;
      if (s.energy <= 0) {
        s.x = 0;
        s.z = 6;
        s.y = 0;
        s.vy = 0;
        s.energy = 3;
        s.dashRemaining = 0;
      }
      break;
    }
  }
  if (s.collected.every(Boolean) && Math.hypot(s.x, s.z) < 1.8) {
    s.won = true;
    events.won = true;
  }
  return events;
}
export function dronePosition(t: number, i: number): { x: number; z: number } {
  const a = t * 0.4 + i * Math.PI;
  return { x: Math.cos(a) * 7, z: Math.sin(a) * 4 };
}
