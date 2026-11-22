// ShapeBuilder3D: hard-surface parts built in code (guns, machines, props). 2D outlines are
// extruded with chamfered rims and cut corners, and profiles are turned on a lathe with bevelled
// corners. Every part splits into two vertex sets. The body holds the flat and curved surfaces,
// with UVs at true scale so a repeating texture keeps one size across parts. The edges hold the
// chamfers and bevels, with UVs running along each edge, so a worn-edge strip (or a brighter
// material) follows the real geometry. Use `build()` for both, or `buildOne()` for a single mesh.

import { Geometry3D } from "./geometry.ts";

type V2 = readonly [number, number];
type V3 = readonly [number, number, number];
/** A 2D point: (a, b) in an outline, (radius, height) in a lathe profile. */
export type ShapePoint2 = V2;

/** Where a part goes in its model: rotated (radians, X then Y then Z) and then moved. */
export interface ShapePlacement3D {
  at?: readonly [number, number, number];
  rot?: readonly [number, number, number];
}

export interface ShapeExtrude3D extends ShapePlacement3D {
  /**
   * The plane the outline is drawn in; it is extruded along the remaining axis.
   * - "x" (side view): outline (forward, up), forward is -z; extruded along x.
   * - "y" (plan view): outline (x, forward); extruded along y.
   * - "z" (front view): outline (x, y); extruded along z.
   */
  axis?: "x" | "y" | "z";
  /** Chamfer on the outline's front and back rims. */
  bevel?: number;
  /** Cut on the outline's convex corners; defaults to the bevel. */
  corner?: number;
  /** Corners turning more than this (degrees) are cut; smaller turns are smoothed. */
  sharp?: number;
}

export interface ShapeLathe3D extends ShapePlacement3D {
  /** The turning axis; the profile's h runs along it (forward, -z, for "z"). */
  axis?: "x" | "y" | "z";
  segments?: number;
  /** Bevel on the profile's sharp convex corners. */
  corner?: number;
  sharp?: number;
  /** Join the last profile point back to the first (a ring or duct). */
  closed?: boolean;
  /**
   * "scale": the texture repeats at true scale. "unit": it wraps once round and once from the
   * first profile point to the last, for a texture made for that body (a drone's shell).
   */
  uv?: "scale" | "unit";
}

class Soup {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  i: number[] = [];
  vert(p: V3, n: V3, u: number, v: number): number {
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  /** A triangle wound to face its vertices' normals; slivers are dropped. */
  tri(a: number, b: number, c: number): void {
    const P = this.p,
      N = this.n;
    const ux = P[b * 3] - P[a * 3],
      uy = P[b * 3 + 1] - P[a * 3 + 1],
      uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3],
      vy = P[c * 3 + 1] - P[a * 3 + 1],
      vz = P[c * 3 + 2] - P[a * 3 + 2];
    const gx = uy * vz - uz * vy,
      gy = uz * vx - ux * vz,
      gz = ux * vy - uy * vx;
    if (gx * gx + gy * gy + gz * gz < 1e-16) return;
    let d = 0;
    for (const k of [a, b, c]) d += gx * N[k * 3] + gy * N[k * 3 + 1] + gz * N[k * 3 + 2];
    if (d >= 0) this.i.push(a, b, c);
    else this.i.push(a, c, b);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  geometry(): Geometry3D | null {
    return this.i.length ? new Geometry3D(this.p, this.n, this.i, this.uv) : null;
  }
  /** Append another soup's vertices and triangles. */
  merge(o: Soup): void {
    const base = this.p.length / 3;
    this.p.push(...o.p);
    this.n.push(...o.n);
    this.uv.push(...o.uv);
    for (const i of o.i) this.i.push(i + base);
  }
}

const cross2 = (a: V2, b: V2, c: V2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const len2 = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const area = (pts: readonly V2[]) => pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2;

/**
 * Cut the sharp convex corners of a polyline: each becomes a short segment flagged as an
 * edge. `convex` is the sign of a convex turn (1 for counter-clockwise outlines).
 */
function cutCorners(pts: readonly V2[], r: number, sharpDeg: number, closed: boolean, convex: 1 | -1): { pts: V2[]; edge: boolean[] } {
  const out: V2[] = [];
  const edge: boolean[] = [];
  const n = pts.length;
  const cos = Math.cos((sharpDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const hasPrev = closed || i > 0,
      hasNext = closed || i < n - 1;
    if (r > 0 && hasPrev && hasNext) {
      const a = pts[(i + n - 1) % n],
        b = pts[(i + 1) % n];
      const la = len2(a, p),
        lb = len2(p, b);
      const da: V2 = [(p[0] - a[0]) / la, (p[1] - a[1]) / la],
        db: V2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
      const turn = Math.sign(cross2(a, p, b));
      // Never cut a corner on the axis of a lathe (r = 0 points stay put).
      const onAxis = !closed && convex < 0 && Math.abs(p[0]) < 1e-6;
      if (turn === convex && da[0] * db[0] + da[1] * db[1] < cos && !onAxis) {
        const c = Math.min(r, la * 0.45, lb * 0.45);
        out.push([p[0] - da[0] * c, p[1] - da[1] * c], [p[0] + db[0] * c, p[1] + db[1] * c]);
        edge.push(true, false);
        continue;
      }
    }
    out.push(p);
    edge.push(false);
  }
  return { pts: out, edge };
}

/** Per-segment outward normals of a polyline whose solid lies on its right (lathe) or left (CCW outline). */
function segmentNormals(pts: readonly V2[], closed: boolean, side: 1 | -1): V2[] {
  const n = pts.length,
    m = closed ? n : n - 1;
  return Array.from({ length: m }, (_, i) => {
    const a = pts[i],
      b = pts[(i + 1) % n];
    const l = len2(a, b) || 1;
    // CCW outline (side 1): outward is right of travel (dy, -dx); lathe (side -1): left (-dy, dx).
    return side > 0 ? [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] : [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  });
}

/** The normal at each end of each segment: shared with the neighbour where the turn is gentle. */
function endNormals(sn: V2[], closed: boolean, smoothDeg: number): [V2, V2][] {
  const m = sn.length,
    cos = Math.cos((smoothDeg * Math.PI) / 180);
  const blend = (a: V2, b: V2): V2 => {
    if (a[0] * b[0] + a[1] * b[1] < cos) return a;
    const x = a[0] + b[0],
      y = a[1] + b[1],
      l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  return sn.map((s, i) => {
    const prev = closed || i > 0 ? sn[(i + m - 1) % m] : null;
    const next = closed || i < m - 1 ? sn[(i + 1) % m] : null;
    return [prev ? blend(s, prev) : s, next ? blend(s, next) : s];
  });
}

/** Offset a CCW outline inward by d (mitred, with long mitres clamped). */
function inset(pts: readonly V2[], d: number): V2[] {
  const n = pts.length;
  const sn = segmentNormals(pts, true, 1);
  return pts.map((p, i) => {
    const a = sn[(i + n - 1) % n],
      b = sn[i];
    let x = a[0] + b[0],
      y = a[1] + b[1];
    const l = Math.hypot(x, y) || 1;
    x /= l;
    y /= l;
    const c = Math.max(0.35, x * b[0] + y * b[1]);
    return [p[0] - (x * d) / c, p[1] - (y * d) / c];
  });
}

/** Ear-clipping triangulation of a simple CCW polygon. */
function triangulate(pts: readonly V2[]): number[] {
  const idx = pts.map((_, i) => i),
    out: number[] = [];
  const inside = (p: V2, a: V2, b: V2, c: V2) => cross2(a, b, p) > 1e-12 && cross2(b, c, p) > 1e-12 && cross2(c, a, p) > 1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 4096) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = pts[i0],
        b = pts[i1],
        c = pts[i2];
      if (cross2(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(pts[j], a, b, c))) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length >= 3) for (let k = 1; k < idx.length - 1; k++) out.push(idx[0], idx[k], idx[k + 1]);
  return out;
}

/** A rotation (X, then Y, then Z) and a move, applied to points and normals. */
function placer(o: ShapePlacement3D): { point: (v: V3) => V3; dir: (v: V3) => V3 } {
  const [rx, ry, rz] = o.rot ?? [0, 0, 0];
  const [tx, ty, tz] = o.at ?? [0, 0, 0];
  const cx = Math.cos(rx),
    sx = Math.sin(rx),
    cy = Math.cos(ry),
    sy = Math.sin(ry),
    cz = Math.cos(rz),
    sz = Math.sin(rz);
  const dir = ([x, y, z]: V3): V3 => {
    let y1 = y * cx - z * sx,
      z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy;
    z1 = -x * sy + z1 * cy;
    const x3 = x2 * cz - y1 * sz;
    y1 = x2 * sz + y1 * cz;
    return [x3, y1, z1];
  };
  return { dir, point: (v) => {
    const r = dir(v);
    return [r[0] + tx, r[1] + ty, r[2] + tz];
  } };
}

/** Extrusion frames: outline (a, b) and depth c to model space. All are proper rotations. */
const EXTRUDE: Record<"x" | "y" | "z", (a: number, b: number, c: number) => V3> = {
  x: (a, b, c) => [c, b, -a],
  y: (a, b, c) => [a, c, -b],
  z: (a, b, c) => [a, b, c],
};
/** Lathe frames: (radial x, along-axis h, radial z) to model space. */
const LATHE: Record<"x" | "y" | "z", (x: number, h: number, z: number) => V3> = {
  x: (x, h, z) => [h, -x, z],
  y: (x, h, z) => [x, h, z],
  z: (x, h, z) => [x, z, -h],
};

const finite = (...v: number[]) => v.every(Number.isFinite);
const finitePoints = (pts: readonly V2[]) => pts.every((p) => p.length === 2 && finite(p[0], p[1]));
function checkPlacement(o: ShapePlacement3D): void {
  if ((o.at && !finite(...o.at)) || (o.rot && !finite(...o.rot))) throw new RangeError("Shape placement must be finite");
}

/** A set of hard-surface parts in one material: `build()` gives the body and edge geometry. */
export class ShapeBuilder3D {
  private body = new Soup();
  private edges = new Soup();
  /**
   * @param uvScale   texture repeats per metre on body surfaces.
   * @param edgeScale edge-strip repeats per metre along edges.
   */
  constructor(
    readonly uvScale = 3,
    readonly edgeScale = 2.5,
  ) {
    if (!finite(uvScale, edgeScale) || uvScale <= 0 || edgeScale <= 0) throw new RangeError("Shape UV scales must be positive");
  }

  /** A box with chamfered edges, centred on `at`. */
  box(w: number, h: number, d: number, o: Omit<ShapeExtrude3D, "axis"> = {}): this {
    if (!finite(w, h, d) || w <= 0 || h <= 0 || d <= 0) throw new RangeError("Shape boxes need positive sizes");
    const x = w / 2,
      y = h / 2;
    return this.extrude([[-x, -y], [x, -y], [x, y], [-x, y]], d, { ...o, axis: "z" });
  }

  /** An outline extruded `depth` deep, centred on its plane, with chamfered rims and corners. */
  extrude(outline: readonly V2[], depth: number, o: ShapeExtrude3D = {}): this {
    if (outline.length < 3 || !finitePoints(outline) || !finite(depth) || depth <= 0 || Math.abs(area(outline)) < 1e-12)
      throw new RangeError("Extrusions need an outline of three or more points with an area, and a positive depth");
    if (!finite(o.bevel ?? 0, o.corner ?? 0, o.sharp ?? 0) || (o.bevel ?? 0) < 0 || (o.corner ?? 0) < 0) throw new RangeError("Bevels must be finite and nonnegative");
    checkPlacement(o);
    const bevel = Math.min(o.bevel ?? 0.006, depth * 0.3);
    const raw = area(outline) < 0 ? [...outline].reverse() : outline;
    const { pts, edge } = cutCorners(raw, o.corner ?? bevel, o.sharp ?? 28, true, 1);
    const n = pts.length;
    const map = EXTRUDE[o.axis ?? "z"];
    const pl = placer(o);
    const P = (a: number, b: number, c: number) => pl.point(map(a, b, c));
    const D = (a: number, b: number, c: number) => norm3(pl.dir(map(a, b, c)));
    const half = depth / 2,
      wall = half - bevel;
    const sn = segmentNormals(pts, true, 1);
    const en = endNormals(sn, true, 30);
    const s = this.uvScale,
      e = this.edgeScale;
    // Walls; corner cuts go to the edges, painted along the extrusion.
    let run = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n],
        l = len2(a, b);
      const [na, nb] = en[i];
      if (edge[i]) {
        const so = this.edges;
        so.quad(
          so.vert(P(a[0], a[1], -wall), D(na[0], na[1], 0), -wall * e, 0),
          so.vert(P(b[0], b[1], -wall), D(nb[0], nb[1], 0), -wall * e, 1),
          so.vert(P(b[0], b[1], wall), D(nb[0], nb[1], 0), wall * e, 1),
          so.vert(P(a[0], a[1], wall), D(na[0], na[1], 0), wall * e, 0),
        );
      } else {
        const so = this.body;
        so.quad(
          so.vert(P(a[0], a[1], -wall), D(na[0], na[1], 0), run * s, -wall * s),
          so.vert(P(b[0], b[1], -wall), D(nb[0], nb[1], 0), (run + l) * s, -wall * s),
          so.vert(P(b[0], b[1], wall), D(nb[0], nb[1], 0), (run + l) * s, wall * s),
          so.vert(P(a[0], a[1], wall), D(na[0], na[1], 0), run * s, wall * s),
        );
      }
      run += l;
    }
    // Rim chamfers between the walls and the caps.
    const capPts = bevel > 0 ? inset(pts, bevel) : pts;
    if (bevel > 0)
      for (const side of [-1, 1]) {
        let at = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n,
            l = len2(pts[i], pts[j]);
          const [na, nb] = en[i];
          const so = this.edges;
          const k = 0.7071;
          so.quad(
            so.vert(P(pts[i][0], pts[i][1], side * wall), D(na[0] * k, na[1] * k, side * k), at * e, 0),
            so.vert(P(pts[j][0], pts[j][1], side * wall), D(nb[0] * k, nb[1] * k, side * k), (at + l) * e, 0),
            so.vert(P(capPts[j][0], capPts[j][1], side * half), D(nb[0] * k, nb[1] * k, side * k), (at + l) * e, 1),
            so.vert(P(capPts[i][0], capPts[i][1], side * half), D(na[0] * k, na[1] * k, side * k), at * e, 1),
          );
          at += l;
        }
      }
    // Caps.
    const tris = triangulate(capPts);
    for (const side of [-1, 1]) {
      const so = this.body;
      const base = capPts.map((p) => so.vert(P(p[0], p[1], side * half), D(0, 0, side), p[0] * s, p[1] * s));
      for (let t = 0; t < tris.length; t += 3) so.tri(base[tris[t]], base[tris[t + 1]], base[tris[t + 2]]);
    }
    return this;
  }

  /**
   * A profile turned round an axis. Points are (radius, h); the solid lies to the right of
   * the direction of travel, so run an outer surface from the top of the axis down.
   */
  lathe(profile: readonly V2[], o: ShapeLathe3D = {}): this {
    if (profile.length < 2 || !finitePoints(profile) || profile.some((p) => p[0] < 0)) throw new RangeError("Lathe profiles need two or more points with nonnegative radii");
    if (o.segments !== undefined && (!Number.isInteger(o.segments) || o.segments < 3 || o.segments > 256)) throw new RangeError("Lathe segments must be an integer from 3 to 256");
    if (!finite(o.corner ?? 0, o.sharp ?? 0) || (o.corner ?? 0) < 0) throw new RangeError("Bevels must be finite and nonnegative");
    checkPlacement(o);
    const closed = o.closed ?? false;
    const { pts, edge } = cutCorners(profile, o.corner ?? 0, o.sharp ?? 40, closed, -1);
    const segs = o.segments ?? 24;
    const map = LATHE[o.axis ?? "y"];
    const pl = placer(o);
    const n = pts.length,
      m = closed ? n : n - 1;
    const sn = segmentNormals(pts, closed, -1);
    const en = endNormals(sn, closed, 32);
    const rMax = Math.max(...pts.map((p) => p[0]));
    const unit = o.uv === "unit";
    const turns = unit ? 1 : Math.max(1, Math.round(2 * Math.PI * rMax * this.uvScale));
    let total = 0;
    for (let i = 0; i < m; i++) total += len2(pts[i], pts[(i + 1) % n]);
    let run = 0;
    for (let i = 0; i < m; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n],
        l = len2(a, b);
      const [na, nb] = en[i];
      const so = edge[i] ? this.edges : this.body;
      const eTurns = Math.max(1, Math.round(2 * Math.PI * Math.max(a[0], b[0]) * this.edgeScale));
      const rowA: number[] = [],
        rowB: number[] = [];
      for (let k = 0; k <= segs; k++) {
        const t = k / segs,
          th = t * Math.PI * 2,
          c = Math.cos(th),
          sn2 = Math.sin(th);
        const vtx = (p: V2, nn: V2, v: number) =>
          so.vert(pl.point(map(p[0] * c, p[1], p[0] * sn2)), norm3(pl.dir(map(nn[0] * c, nn[1], nn[0] * sn2))), edge[i] ? t * eTurns : t * turns, v);
        if (edge[i]) {
          rowA.push(vtx(a, na, 0));
          rowB.push(vtx(b, nb, 1));
        } else if (unit) {
          rowA.push(vtx(a, na, run / total));
          rowB.push(vtx(b, nb, (run + l) / total));
        } else {
          rowA.push(vtx(a, na, run * this.uvScale));
          rowB.push(vtx(b, nb, (run + l) * this.uvScale));
        }
      }
      for (let k = 0; k < segs; k++) so.quad(rowA[k], rowA[k + 1], rowB[k + 1], rowB[k]);
      run += l;
    }
    return this;
  }

  /** The body and edge geometry so far (null where a set is empty). */
  build(): { body: Geometry3D | null; edge: Geometry3D | null } {
    return { body: this.body.geometry(), edge: this.edges.geometry() };
  }
  /** Body and edges as one geometry, for a part drawn in a single material. */
  buildOne(): Geometry3D | null {
    const all = new Soup();
    all.merge(this.body);
    all.merge(this.edges);
    return all.geometry();
  }
}

/** Points along a circular arc (centre, radius, from and to angles in radians), for outlines and profiles. */
export function arcPoints(cx: number, cy: number, r: number, from: number, to: number, steps = 8): [number, number][] {
  if (!finite(cx, cy, r, from, to) || !Number.isInteger(steps) || steps < 1 || steps > 1024) throw new RangeError("Arcs need finite values and 1 to 1024 steps");
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / steps;
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
  });
}

/** Mirror an outline left to right (a → −a), keeping its winding valid. */
export const mirrorOutline = (pts: readonly V2[]): [number, number][] => pts.map(([a, b]) => [-a, b] as [number, number]).reverse();
