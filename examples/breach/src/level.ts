import { Vec3, type WeaponDefinition3D } from "@blackiron-studio/engine/three";
export const SPAWN = new Vec3(0, 0.04, 19);
export const WEAPONS: readonly WeaponDefinition3D[] = [
  {
    id: "AR-04 / PULSE RIFLE",
    magazine: 28,
    reserve: 224,
    interval: 0.115,
    reloadSeconds: 1.35,
    damage: 22,
    range: 85,
    pellets: 1,
    spread: 0.005,
    automatic: true,
  },
  {
    id: "SG-08 / SCATTERGUN",
    magazine: 6,
    reserve: 48,
    interval: 0.72,
    reloadSeconds: 1.75,
    damage: 15,
    range: 32,
    pellets: 9,
    spread: 0.08,
    automatic: false,
  },
];
export interface Solid {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  kind: "wall" | "cover" | "platform" | "step" | "floor";
}
export const SOLIDS: Solid[] = [
  { x: 0, y: -0.5, z: -3, w: 50, h: 1, d: 58, kind: "floor" },
  { x: 0, y: 4, z: -32, w: 50, h: 8, d: 1, kind: "wall" },
  { x: -25, y: 3, z: -3, w: 1, h: 6, d: 58, kind: "wall" },
  { x: 25, y: 3, z: -3, w: 1, h: 6, d: 58, kind: "wall" },
  { x: 0, y: 3, z: 26, w: 50, h: 6, d: 1, kind: "wall" },
  { x: 0, y: 1.35, z: -5, w: 6, h: 2.7, d: 6, kind: "cover" },
  ...[-1, 1].flatMap((sign) => [
    {
      x: sign * 18,
      y: 1.1,
      z: -9,
      w: 9,
      h: 2.2,
      d: 20,
      kind: "platform" as const,
    },
    {
      x: sign * 8,
      y: 0.95,
      z: 10,
      w: 3.8,
      h: 1.9,
      d: 3,
      kind: "cover" as const,
    },
    { x: sign * 10, y: 1.3, z: -3, w: 3, h: 2.6, d: 4, kind: "cover" as const },
    { x: sign * 6, y: 0.7, z: -20, w: 4, h: 1.4, d: 3, kind: "cover" as const },
    ...Array.from({ length: 10 }, (_, i) => ({
      x: sign * 18,
      y: (i + 1) * 0.11,
      z: 7.65 - i * 0.7,
      w: 4,
      h: (i + 1) * 0.22,
      d: 0.7,
      kind: "step" as const,
    })),
  ]),
  // A low service ramp, modelled as a static triangle mesh separately.
];
export const RELAYS = [
  new Vec3(-18, 2.2, -13),
  new Vec3(18, 2.2, -13),
  new Vec3(0, 0, -25),
];
export const ENEMY_SPAWNS = [
  new Vec3(-10, 0, 0),
  new Vec3(10, 0, -14),
  new Vec3(-8, 0, -24),
  new Vec3(9, 0, 14),
  new Vec3(-12, 0, 16),
  new Vec3(10, 0, -25),
  new Vec3(0, 0, -15),
  new Vec3(5, 0, 7),
];
export const WAVES = [3, 4, 5];
export type Phase = "title" | "playing" | "paused" | "won" | "lost";
export class BreachRun {
  phase: Phase = "title";
  health = 100;
  kills = 0;
  wave = 0;
  time = 0;
  damageFlash = 0;
  hitMarker = 0;
  notice = "";
  noticeTime = 0;
  relays = [false, false, false];
  damage(amount: number): void {
    if (this.phase !== "playing") return;
    this.health = Math.max(0, this.health - amount);
    this.damageFlash = 0.4;
    if (this.health === 0) this.phase = "lost";
  }
  get completed(): number {
    return this.relays.filter(Boolean).length;
  }
}
