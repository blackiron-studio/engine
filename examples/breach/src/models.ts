// Modelled guns, drones and props: outlines extruded with chamfered rims and profiles turned on a
// lathe, built with the engine's ShapeBuilder3D. A model is a set of parts, each a shape in one
// finish, plus glowing inserts. The presentation mounts them.

import { ShapeBuilder3D as Shape, mirrorOutline as mirror } from "@blackiron-studio/engine/three";
import type { Finish } from "./presentation.ts";

type V2 = [number, number];
type V3 = [number, number, number];

export interface Model {
  parts: { shape: Shape; finish: Finish }[];
  glows: { shape: Shape; color: number }[];
}

class Kit {
  private parts = new Map<string, Model["parts"][number]>();
  private glows = new Map<number, Shape>();
  /** The shape for one finish; repeated calls add to the same part. */
  part(finish: Finish, uvScale = 3, edgeScale = 2.5): Shape {
    const key = `${finish.join("/")}/${uvScale}`;
    let p = this.parts.get(key);
    if (!p) this.parts.set(key, (p = { shape: new Shape(uvScale, edgeScale), finish }));
    return p.shape;
  }
  glow(color: number): Shape {
    let g = this.glows.get(color);
    if (!g) this.glows.set(color, (g = new Shape(1, 1)));
    return g;
  }
  done(): Model {
    return { parts: [...this.parts.values()], glows: [...this.glows.entries()].map(([color, shape]) => ({ shape, color })) };
  }
}

// ------------------------------------------------------------------ finishes
const GM: Finish = [0x2b3138, 0.45, 0.55];
const POLY: Finish = [0x14181c, 0.7, 0.05];
const PAINT: Finish = [0xd96e30, 0.45, 0.2];
const BONE: Finish = [0x8f8c84, 0.5, 0.05];
const CHROME: Finish = [0x9aa3ab, 0.22, 0.9];
// The presentation's palette (P), repeated here to keep this module free of runtime imports.
const CYAN = 0x5ff3d8;
const AMBER = 0xffb347;
const RED = 0xff4b3e;

/** A bolt head facing +z, placed at `at`. */
function stud(s: Shape, at: V3, r = 0.02): void {
  s.lathe([[0, r * 0.6], [r * 0.7, r * 0.5], [r, r * 0.2], [r, 0], [0, 0]], { axis: "x", segments: 10, at, rot: [0, -Math.PI / 2, 0] });
}

/** A domed bolt head facing +x (side 1) or -x (side -1). */
function bolt(s: Shape, at: V3, side: 1 | -1, r = 0.0065): void {
  s.lathe([[0, 0.004], [r * 0.7, 0.0035], [r, 0.0015], [r, 0], [0, 0]], { axis: "x", segments: 10, at, rot: side > 0 ? [0, 0, 0] : [0, Math.PI, 0] });
}

// ------------------------------------------------------------------ guns
// Gun space: x right, y up, forward -z; outlines are side views (forward, up), extruded across.

/** Grip, trigger guard and trigger shared by both guns. */
function lowerGroup(k: Kit): void {
  k.part(POLY, 6).extrude(
    [[-0.045, -0.265], [-0.005, -0.278], [0.028, -0.255], [0.05, -0.17], [0.075, -0.095], [-0.01, -0.095], [-0.03, -0.18]],
    0.064,
    { axis: "x", bevel: 0.01, corner: 0.012 },
  );
  // Finger grooves on the grip's front.
  for (const [a, b] of [[0.064, -0.13], [0.05, -0.17], [0.039, -0.21]]) k.part(GM, 6).box(0.066, 0.008, 0.014, { at: [0, b, -a], bevel: 0.002, rot: [-0.3, 0, 0] });
  k.part(GM, 6).extrude(
    [[0.055, -0.162], [0.152, -0.162], [0.168, -0.1], [0.152, -0.1], [0.142, -0.148], [0.07, -0.148], [0.068, -0.1], [0.055, -0.1]],
    0.024,
    { axis: "x", bevel: 0.004, corner: 0.005 },
  );
  k.part(POLY, 6).extrude([[0.098, -0.1], [0.114, -0.1], [0.11, -0.138], [0.096, -0.132]], 0.012, { axis: "x", bevel: 0.002 });
}

/** The AR-04 pulse rifle. */
export function pulseRifle(): Model {
  const k = new Kit();
  const gm = k.part(GM, 6),
    chrome = k.part(CHROME, 8);
  // Receiver with a magazine well and a raised side plate.
  gm.extrude(
    [[-0.1, -0.1], [0.135, -0.1], [0.142, -0.125], [0.252, -0.125], [0.26, -0.1], [0.4, -0.1], [0.46, -0.065], [0.46, 0.02], [0.42, 0.045], [-0.06, 0.045], [-0.1, 0.015]],
    0.12,
    { axis: "x", bevel: 0.008, corner: 0.01 },
  );
  gm.extrude([[0.0, -0.078], [0.3, -0.078], [0.34, -0.045], [0.34, 0.022], [0.0, 0.022]], 0.128, { axis: "x", bevel: 0.003, corner: 0.006 });
  for (const side of [1, -1] as const) for (const [a, b] of [[0.02, -0.062], [0.02, 0.008], [0.28, -0.062], [0.28, 0.008]]) bolt(chrome, [side * 0.064, b, -a], side);
  // Upper shroud running over the barrel, with glowing vents along its sides.
  k.part(PAINT, 5).extrude(
    [[-0.04, 0.035], [0.4, 0.035], [0.44, 0.0], [0.6, 0.0], [0.625, 0.03], [0.6, 0.08], [0.32, 0.105], [0.02, 0.105], [-0.04, 0.08]],
    0.15,
    { axis: "x", bevel: 0.01, corner: 0.012 },
  );
  for (const side of [1, -1]) for (let i = 0; i < 4; i++) k.glow(CYAN).box(0.004, 0.032, 0.022, { at: [side * 0.0755, 0.042, -(0.45 + i * 0.038)], bevel: 0 });
  // Lower handguard with ribs.
  k.part(POLY, 6).extrude([[0.4, -0.08], [0.57, -0.08], [0.595, -0.055], [0.595, 0.0], [0.4, 0.0]], 0.11, { axis: "x", bevel: 0.008, corner: 0.01 });
  for (let i = 0; i < 5; i++) gm.box(0.118, 0.06, 0.012, { at: [0, -0.044, -(0.425 + i * 0.035)], bevel: 0.002 });
  // Barrel with a slotted muzzle brake.
  chrome.lathe(
    [[0, 0.77], [0.009, 0.77], [0.009, 0.8], [0.024, 0.8], [0.024, 0.757], [0.019, 0.752], [0.019, 0.742], [0.024, 0.737], [0.024, 0.705], [0.015, 0.698], [0.015, 0.6], [0.021, 0.595], [0.021, 0.575], [0, 0.575]],
    { axis: "z", segments: 20, corner: 0.002 },
  );
  // Top rail.
  gm.extrude([[0.12, 0.1], [0.42, 0.1], [0.42, 0.113], [0.12, 0.113]], 0.04, { axis: "x", bevel: 0.002 });
  for (let i = 0; i < 10; i++) gm.box(0.046, 0.008, 0.012, { at: [0, 0.117, -(0.135 + i * 0.03)], bevel: 0.0015 });
  // Optic: mount, housing, glowing eyepiece and a dark front lens.
  gm.extrude([[0.0, 0.1], [0.1, 0.1], [0.09, 0.13], [0.01, 0.13]], 0.045, { axis: "x", bevel: 0.004 });
  gm.lathe(
    [[0, 0.13], [0.026, 0.13], [0.03, 0.124], [0.03, 0.1], [0.024, 0.094], [0.024, 0.03], [0.031, 0.024], [0.031, -0.015], [0.025, -0.022], [0, -0.022]],
    { axis: "z", segments: 20, corner: 0.002, at: [0, 0.155, 0] },
  );
  k.glow(CYAN).lathe([[0.021, -0.0225], [0, -0.0225]], { axis: "z", segments: 20, at: [0, 0.155, 0] });
  k.part(POLY).lathe([[0, 0.1305], [0.022, 0.1305]], { axis: "z", segments: 20, at: [0, 0.155, 0] });
  // Stock with a dark grip panel, a connector and a butt pad.
  k.part(GM, 5).extrude([[-0.46, -0.175], [-0.4, -0.175], [-0.1, -0.08], [-0.1, 0.02], [-0.3, 0.045], [-0.46, 0.035]], 0.07, { axis: "x", bevel: 0.01, corner: 0.015 });
  k.part(POLY, 6).extrude([[-0.38, -0.125], [-0.17, -0.072], [-0.17, -0.005], [-0.36, 0.004]], 0.074, { axis: "x", bevel: 0.003 });
  k.part(POLY, 6).extrude([[-0.495, -0.185], [-0.455, -0.185], [-0.455, 0.045], [-0.495, 0.04]], 0.08, { axis: "x", bevel: 0.012 });
  gm.lathe([[0, -0.08], [0.026, -0.08], [0.026, -0.12], [0, -0.12]], { axis: "z", segments: 16, corner: 0.004, at: [0, -0.02, 0] });
  // Charging handle and the side energy strip.
  gm.box(0.03, 0.02, 0.04, { at: [0.075, 0.025, -0.36], bevel: 0.004 });
  k.glow(CYAN).box(0.004, 0.018, 0.16, { at: [0.0665, -0.03, -0.17], bevel: 0 });
  lowerGroup(k);
  return k.done();
}

/** The rifle's energy-cell magazine with its glowing charge windows (moves on reload). */
export function rifleMag(): Model {
  const k = new Kit();
  k.part(GM, 6).extrude([[0.19, -0.32], [0.262, -0.305], [0.25, -0.215], [0.24, -0.125], [0.15, -0.125], [0.168, -0.22]], 0.052, { axis: "x", bevel: 0.007, corner: 0.008 });
  k.part(POLY, 6).extrude([[0.184, -0.336], [0.272, -0.318], [0.266, -0.3], [0.188, -0.313]], 0.058, { axis: "x", bevel: 0.004 });
  for (const side of [1, -1]) k.glow(CYAN).box(0.004, 0.06, 0.03, { at: [side * 0.0265, -0.2, -0.205], bevel: 0, rot: [0.12, 0, 0] });
  return k.done();
}

/** The scattergun's pump fore-end with grooves (racked after every shot). */
export function scatterPump(): Model {
  const k = new Kit();
  k.part(POLY, 6).extrude([[0.34, -0.1], [0.55, -0.1], [0.58, -0.075], [0.58, -0.03], [0.55, -0.02], [0.34, -0.02]], 0.14, { axis: "x", bevel: 0.01, corner: 0.012 });
  for (let i = 0; i < 6; i++) k.part(GM, 6).box(0.148, 0.05, 0.01, { at: [0, -0.06, -(0.37 + i * 0.03)], bevel: 0.002 });
  return k.done();
}

/** The double-barrelled scattergun. */
export function scattergun(): Model {
  const k = new Kit();
  const gm = k.part(GM, 6),
    chrome = k.part(CHROME, 8);
  gm.extrude([[-0.1, -0.11], [0.12, -0.11], [0.3, -0.1], [0.33, -0.06], [0.33, 0.03], [0.3, 0.06], [-0.05, 0.06], [-0.1, 0.02]], 0.15, { axis: "x", bevel: 0.01, corner: 0.012 });
  for (const side of [1, -1] as const) for (const [a, b] of [[0.0, -0.08], [0.0, 0.03], [0.26, -0.08], [0.26, 0.03]]) bolt(chrome, [side * 0.075, b, -a], side, 0.008);
  // Top cover and a heat shield over the barrels with amber vents.
  k.part(BONE, 5).extrude([[-0.06, 0.05], [0.3, 0.05], [0.36, 0.035], [0.36, 0.06], [0.3, 0.1], [-0.02, 0.1], [-0.06, 0.08]], 0.16, { axis: "x", bevel: 0.01, corner: 0.012 });
  k.part(BONE, 5).extrude([[0.33, 0.028], [0.6, 0.028], [0.635, 0.05], [0.6, 0.078], [0.33, 0.088]], 0.15, { axis: "x", bevel: 0.008, corner: 0.01 });
  for (const side of [1, -1]) for (let i = 0; i < 4; i++) k.glow(AMBER).box(0.004, 0.026, 0.03, { at: [side * 0.0755, 0.055, -(0.37 + i * 0.055)], bevel: 0 });
  // Twin barrels, a clamp band and a front sight.
  for (const x of [-0.032, 0.032])
    chrome.lathe([[0, 0.74], [0.016, 0.74], [0.016, 0.78], [0.03, 0.78], [0.03, 0.735], [0.026, 0.728], [0.026, 0.3], [0, 0.3]], { axis: "z", segments: 20, corner: 0.003, at: [x, 0, 0] });
  gm.box(0.142, 0.072, 0.03, { at: [0, -0.004, -0.66], bevel: 0.006 });
  k.glow(AMBER).box(0.018, 0.018, 0.018, { at: [0, 0.09, -0.6], bevel: 0 });
  // Shell carrier on the left with four glowing shells.
  gm.box(0.012, 0.09, 0.23, { at: [-0.081, -0.03, -0.12], bevel: 0.003 });
  for (let i = 0; i < 4; i++) {
    const at: V3 = [-0.094, -0.03, -(0.035 + i * 0.056)];
    k.glow(RED).lathe([[0, 0.03], [0.013, 0.03], [0.013, -0.018], [0, -0.018]], { axis: "y", segments: 12, at });
    chrome.lathe([[0, -0.018], [0.0145, -0.018], [0.0145, -0.032], [0, -0.032]], { axis: "y", segments: 12, corner: 0.002, at });
  }
  k.glow(AMBER).box(0.004, 0.02, 0.16, { at: [0.0765, -0.03, -0.15], bevel: 0 });
  // Chunky stock and pad.
  k.part(GM, 5).extrude([[-0.44, -0.18], [-0.36, -0.18], [-0.1, -0.09], [-0.1, 0.03], [-0.44, 0.04]], 0.08, { axis: "x", bevel: 0.012, corner: 0.016 });
  k.part(POLY, 6).extrude([[-0.475, -0.19], [-0.435, -0.19], [-0.435, 0.05], [-0.475, 0.045]], 0.09, { axis: "x", bevel: 0.012 });
  lowerGroup(k);
  return k.done();
}

// ------------------------------------------------------------------ drones
// Drone space: forward -z, hovering at its centre; about 2.3 m across the rotor ducts.

export interface DroneModel {
  /**
   * The drone in pieces that hold together while it flies and come apart when it is destroyed:
   * each with its geometry in drone space, the point it tumbles about and its rough size.
   */
  chunks: { model: Model; center: V3; radius: number }[];
  /** One set of blades, mounted at each duct and spun there. */
  blades: Model;
  ducts: V3[];
  /** Where the glowing eye sits, and its size. */
  eye: { at: V3; scale: V3 };
  /** Small red running lights. */
  lights: V3[];
  /** The tips of the twin barrels under the shell. */
  muzzles: V3[];
}

export function drone(heavy: boolean): DroneModel {
  const hull: Finish = heavy ? [0x2a3036, 0.4, 0.7] : [0xbfc4c6, 0.35, 0.35];
  const armour: Finish = [heavy ? 0xd2652a : 0x3a444d, 0.45, 0.4];
  const dark: Finish = [0x111518, 0.6, 0.3];
  const shell = new Kit(),
    eye = new Kit(),
    pod = new Kit(),
    mast = new Kit(),
    sides = [new Kit(), new Kit()];
  const chunks: DroneModel["chunks"] = [];
  // Armoured shell: a dome, a bevelled belt and a shallower underside.
  shell.part(hull).lathe(
    [[0, 0.44], [0.2, 0.43], [0.38, 0.37], [0.5, 0.27], [0.57, 0.15], [0.595, 0.065], [0.64, 0.05], [0.645, 0], [0.64, -0.05], [0.595, -0.065], [0.55, -0.18], [0.43, -0.31], [0.24, -0.39], [0, -0.41]],
    { axis: "y", segments: 36, corner: 0.014, uv: "unit" },
  );
  // Eye housing: a cup in front holding the glowing core.
  eye.part(armour, 2.5).lathe([[0, 0.08], [0.15, 0.08], [0.15, 0.24], [0.2, 0.24], [0.225, 0.215], [0.225, 0.0], [0, 0.0]], { axis: "z", segments: 28, corner: 0.012, at: [0, -0.02, -0.48] });
  // Arms out to the ducts, with top plates; ducted rotors with a cross of struts and a hub;
  // a landing strut under each arm. One side each.
  const armPlan: V2[] = [[0.45, -0.17], [0.86, -0.11], [0.86, 0.11], [0.45, 0.17]];
  const platePlan: V2[] = [[0.36, -0.21], [0.62, -0.18], [0.7, -0.1], [0.7, 0.1], [0.62, 0.18], [0.36, 0.21]];
  const ducts: V3[] = [[-1.08, 0, 0], [1.08, 0, 0]];
  for (const [i, k] of sides.entries()) {
    const right = i === 1,
      at = ducts[i];
    const arm = k.part(armour, 2.5),
      darkP = k.part(dark, 3);
    arm.extrude(right ? armPlan : mirror(armPlan), 0.09, { axis: "y", bevel: 0.012, corner: 0.02 });
    arm.extrude(right ? platePlan : mirror(platePlan), 0.04, { axis: "y", bevel: 0.008, corner: 0.02, at: [0, 0.062, 0] });
    darkP.lathe([[0.29, -0.07], [0.29, 0.07], [0.32, 0.1], [0.37, 0.09], [0.385, 0.03], [0.37, -0.09]], { axis: "y", segments: 36, corner: 0.008, closed: true, at });
    arm.lathe([[0.385, 0.035], [0.4, 0.03], [0.4, -0.03], [0.383, -0.035]], { axis: "y", segments: 36, at });
    for (const r of [0, Math.PI / 2]) darkP.box(0.6, 0.02, 0.032, { at: [at[0], -0.045, at[2]], rot: [0, r, 0], bevel: 0.004 });
    darkP.lathe([[0, 0.03], [0.055, 0.03], [0.055, -0.07], [0, -0.07]], { axis: "y", segments: 16, corner: 0.01, at });
    darkP.lathe([[0, -0.04], [0.045, -0.04], [0.045, -0.08], [0.028, -0.5], [0, -0.5]], { axis: "y", segments: 14, corner: 0.006, at: [right ? 0.72 : -0.72, 0, 0.02] });
  }
  // Gun pod under the shell with twin barrels.
  pod.part(dark, 3).extrude([[-0.12, -0.44], [0.2, -0.44], [0.27, -0.39], [0.25, -0.33], [-0.1, -0.33]], 0.24, { axis: "x", bevel: 0.014, corner: 0.02 });
  for (const x of [-0.065, 0.065])
    pod.part(CHROME, 6).lathe([[0, 0.38], [0.012, 0.38], [0.012, 0.4], [0.026, 0.4], [0.026, 0.37], [0.02, 0.364], [0.02, 0.2], [0, 0.2]], { axis: "z", segments: 16, corner: 0.003, at: [x, -0.39, 0] });
  // Antenna on top.
  mast.part(dark, 3).lathe([[0, 0.27], [0.011, 0.27], [0.011, 0.03], [0.032, 0.0], [0.032, -0.03], [0, -0.03]], { axis: "y", segments: 12, corner: 0.004, at: [0.12, 0.42, 0.16] });
  chunks.push({ model: shell.done(), center: [0, 0, 0], radius: 0.5 });
  chunks.push({ model: eye.done(), center: [0, -0.02, -0.56], radius: 0.18 });
  chunks.push({ model: sides[0].done(), center: [-0.9, 0, 0], radius: 0.34 });
  chunks.push({ model: sides[1].done(), center: [0.9, 0, 0], radius: 0.34 });
  chunks.push({ model: pod.done(), center: [0, -0.385, -0.08], radius: 0.16 });
  chunks.push({ model: mast.done(), center: [0.12, 0.56, 0.16], radius: 0.06 });
  // Heavy drones carry an armoured collar (on the shell) and side skirts.
  if (heavy) {
    const collar = new Kit();
    collar.part(armour, 2.5).lathe([[0.62, -0.1], [0.62, 0.1], [0.68, 0.125], [0.73, 0.085], [0.73, -0.085], [0.68, -0.125]], { axis: "y", segments: 36, corner: 0.012, closed: true });
    chunks.push({ model: collar.done(), center: [0, 0, 0], radius: 0.6 });
    for (const side of [1, -1]) {
      const skirt = new Kit();
      skirt.part(armour, 2.5).extrude([[-0.3, -0.32], [0.25, -0.32], [0.32, -0.2], [0.25, -0.075], [-0.3, -0.075]], 0.05, { axis: "x", bevel: 0.01, corner: 0.02, at: [side * 0.56, 0, 0] });
      chunks.push({ model: skirt.done(), center: [side * 0.58, -0.2, 0], radius: 0.2 });
    }
  }
  // Blades: three tapered blades round the duct centre.
  const kb = new Kit();
  const blade = kb.part(dark, 3);
  for (let i = 0; i < 3; i++) blade.extrude([[0.04, -0.035], [0.27, -0.05], [0.285, -0.01], [0.27, 0.025], [0.04, 0.035]], 0.012, { axis: "y", bevel: 0.003, corner: 0.006, rot: [0, (i * Math.PI * 2) / 3, 0] });
  return {
    chunks,
    blades: kb.done(),
    ducts,
    eye: { at: [0, -0.02, -0.63], scale: [0.14, 0.14, 0.09] },
    lights: [[-0.72, -0.52, 0.02], [0.72, -0.52, 0.02], [0.12, 0.72, 0.16]],
    muzzles: [[-0.065, -0.39, -0.41], [0.065, -0.39, -0.41]],
  };
}

/** An oil drum with rolling hoops and a lid bung, 1.1 m tall, standing on y = 0. */
export function drum(color: number): Model {
  const k = new Kit();
  const f: Finish = [color, 0.55, 0.3];
  k.part(f, 2).lathe(
    [[0, 1.08], [0.34, 1.08], [0.36, 1.1], [0.38, 1.1], [0.38, 0.95], [0.395, 0.93], [0.395, 0.89], [0.38, 0.87], [0.38, 0.23], [0.395, 0.21], [0.395, 0.17], [0.38, 0.15], [0.38, 0.0], [0, 0.0]],
    { axis: "y", segments: 32, corner: 0.012 },
  );
  k.part(GM, 4).lathe([[0, 1.115], [0.05, 1.115], [0.05, 1.08], [0, 1.08]], { axis: "y", segments: 14, corner: 0.006, at: [0.18, 0, 0.08] });
  return k.done();
}

/** Steel corner caps for a crate of the given size, centred on its base. */
export function crateCaps(w: number, h: number, d: number): Model {
  const k = new Kit();
  const cap = k.part(GM, 3);
  const c = 0.24;
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    cap.box(c, c, c, { at: [sx * (w / 2 - c / 2 + 0.02), sy ? h - c / 2 + 0.02 : c / 2 - 0.02, sz * (d / 2 - c / 2 + 0.02)], bevel: 0.025 });
  }
  // Vertical ribs on the long faces.
  for (const sz of [-1, 1]) for (const x of [-w / 6, w / 6]) cap.box(0.09, h - 0.5, 0.05, { at: [x, h / 2, sz * (d / 2 + 0.015)], bevel: 0.015 });
  for (const sx of [-1, 1]) cap.box(0.05, h - 0.5, 0.09, { at: [sx * (w / 2 + 0.015), h / 2, 0], bevel: 0.015 });
  return k.done();
}

/**
 * A relay console: a cabinet with sloped shoulders, a screen frame on top, side vents, and
 * two masts with collars. Centred on its base, facing +z.
 */
export function console_(): Model {
  const k = new Kit();
  const cab = k.part([0x39434c, 0.6, 0.45], 1.6, 1.5);
  cab.extrude([[-0.65, 0.16], [0.65, 0.16], [0.65, 0.92], [0.46, 1.16], [-0.46, 1.16], [-0.65, 0.92]], 1.42, { axis: "x", bevel: 0.035, corner: 0.04 });
  const gm = k.part(GM, 3);
  gm.box(1.05, 0.08, 0.86, { at: [0, 1.2, 0], bevel: 0.02 });
  for (const side of [-1, 1]) for (let i = 0; i < 6; i++) gm.box(0.04, 0.46, 0.06, { at: [side * 0.725, 0.6, -0.32 + i * 0.128], bevel: 0.01 });
  // Front panel with handles.
  gm.box(0.9, 0.5, 0.04, { at: [0, 0.6, 0.665], bevel: 0.012 });
  for (const x of [-0.41, 0.41]) k.part(CHROME, 4).box(0.04, 0.3, 0.04, { at: [x, 0.6, 0.705], bevel: 0.01 });
  // Masts with collars, from the shoulders up to the ring.
  for (const x of [-0.62, 0.62]) {
    gm.lathe([[0, 2.7], [0.035, 2.7], [0.035, 1.2], [0, 1.2]], { axis: "y", segments: 14, corner: 0.006, at: [x, 0, 0] });
    for (const y of [1.25, 1.9, 2.55]) gm.lathe([[0, y + 0.05], [0.055, y + 0.05], [0.055, y - 0.05], [0, y - 0.05]], { axis: "y", segments: 14, corner: 0.012, at: [x, 0, 0] });
  }
  gm.box(1.3, 0.05, 0.05, { at: [0, 2.7, 0], bevel: 0.012 });
  return k.done();
}

/** A raised steel frame round a sign of w x h facing +z, with a bolt in each corner. */
export function signFrame(w: number, h: number): Model {
  const k = new Kit();
  const f = k.part(GM, 2.5);
  const t = Math.min(0.12, Math.max(0.05, Math.min(w, h) * 0.08));
  for (const sy of [-1, 1]) f.box(w + 2 * t - 0.04, t, 0.06, { at: [0, sy * (h / 2 + t / 2 - 0.02), -0.01], bevel: 0.012 });
  for (const sx of [-1, 1]) f.box(t, h - 0.04, 0.06, { at: [sx * (w / 2 + t / 2 - 0.02), 0, -0.01], bevel: 0.012 });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) stud(k.part(CHROME, 6), [sx * (w / 2 + t / 2 - 0.02), sy * (h / 2 + t / 2 - 0.02), 0.02], t * 0.22);
  return k.done();
}

/**
 * Steel dressing for a cover block of w x h x d centred on the origin: corner posts and a
 * bolted frame on each face, so the big faces read as panels.
 */
export function barrierFrame(w: number, h: number, d: number): Model {
  const k = new Kit();
  const f = k.part(GM, 2);
  const bolts = k.part(CHROME, 6);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) f.box(0.16, h - 0.12, 0.16, { at: [sx * (w / 2 - 0.05), -0.02, sz * (d / 2 - 0.05)], bevel: 0.025 });
  // Faces: (width, outward offset, turn about y) for +z, -z, +x, -x.
  const faces: [number, number, number][] = [[w, d / 2, 0], [w, d / 2, Math.PI], [d, w / 2, Math.PI / 2], [d, w / 2, -Math.PI / 2]];
  for (const [fw, off, ry] of faces) {
    const c = Math.cos(ry),
      sn = Math.sin(ry);
    // Face-local (u across, y, outward) to model space.
    const at = (u: number, y: number, out: number): V3 => [u * c + out * sn, y, -u * sn + out * c];
    const iw = fw - 0.7,
      ih = h - 0.7;
    if (iw < 0.4 || ih < 0.3) continue;
    for (const sy of [-1, 1]) f.box(iw, 0.07, 0.04, { at: at(0, sy * ih / 2, off + 0.015), rot: [0, ry, 0], bevel: 0.012 });
    for (const su of [-1, 1]) f.box(0.07, ih - 0.07, 0.04, { at: at(su * iw / 2, 0, off + 0.015), rot: [0, ry, 0], bevel: 0.012 });
    for (const su of [-1, 1]) for (const sy of [-1, 1]) {
      const p = at(su * iw / 2, sy * ih / 2, off + 0.035);
      bolts.lathe([[0, 0.012], [0.014, 0.01], [0.02, 0.004], [0.02, 0], [0, 0]], { axis: "x", segments: 10, at: p, rot: [0, ry - Math.PI / 2, 0] });
    }
  }
  return k.done();
}

/** Bolted steel collars for a 0.7 x 0.8 pillar standing on y = 0. */
export function pillarCollars(): Model {
  const k = new Kit();
  const f = k.part(GM, 2.5);
  const bolts = k.part(CHROME, 6);
  for (const y of [2.4, 5.8]) {
    f.box(0.84, 0.18, 0.94, { at: [0, y, 0], bevel: 0.03 });
    for (const sz of [-1, 1]) for (const x of [-0.25, 0.25]) bolts.lathe([[0, 0.012], [0.014, 0.01], [0.02, 0.004], [0.02, 0], [0, 0]], { axis: "x", segments: 10, at: [x, y, sz * 0.47], rot: [0, sz > 0 ? -Math.PI / 2 : Math.PI / 2, 0] });
    for (const sx of [-1, 1]) for (const z of [-0.28, 0.28]) bolts.lathe([[0, 0.012], [0.014, 0.01], [0.02, 0.004], [0.02, 0], [0, 0]], { axis: "x", segments: 10, at: [sx * 0.42, y, z], rot: [0, sx > 0 ? 0 : Math.PI, 0] });
  }
  return k.done();
}
