import { Node2D } from "./node.ts";
import type { DrawContext } from "./draw.ts";

export type Point2D = readonly [number, number];
export interface Fill2D {
  color: number;
  alpha?: number;
  additive?: boolean;
}
type Shape = {
  positions: number[];
  vertices: Float32Array;
  fill: Fill2D;
  u: number;
  v: number;
};
const cross = (a: Point2D, b: Point2D, c: Point2D) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Ear clipping for simple polygons, either winding. Holes and self intersections are unsupported. */
export function triangulatePolygon(input: readonly Point2D[]): number[] {
  const p = input.filter(
    (v, i) => i === 0 || v[0] !== input[i - 1][0] || v[1] !== input[i - 1][1],
  );
  if (p.length > 1 && p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1])
    p.pop();
  if (p.some((v) => !Number.isFinite(v[0]) || !Number.isFinite(v[1])))
    throw new Error("Polygon coordinates must be finite");
  if (p.length < 3) return [];
  // Translate before measuring area: shoelace products lose small polygons far from zero.
  let area = 0,
    extent = 0;
  for (let i = 1; i < p.length; i++) {
    extent = Math.max(
      extent,
      Math.abs(p[i][0] - p[0][0]),
      Math.abs(p[i][1] - p[0][1]),
    );
    if (i + 1 < p.length) area += cross(p[0], p[i], p[i + 1]);
  }
  const epsilon = Number.EPSILON * extent * extent * 16;
  if (Math.abs(area) <= epsilon) return [];
  const sign = Math.sign(area),
    indices = p.map((_, i) => i),
    out: number[] = [];
  // Most retained primitives are convex. Fan them in linear time rather than ear clipping
  // every ellipse in a scene full of trees, stones and rounded panels.
  if (
    p.every(
      (v, i) =>
        cross(p[(i + p.length - 1) % p.length], v, p[(i + 1) % p.length]) *
          sign >=
        -epsilon,
    )
  ) {
    for (let i = 1; i + 1 < p.length; i++) {
      if (Math.abs(cross(p[0], p[i], p[i + 1])) > epsilon)
        out.push(...p[0], ...p[i], ...p[i + 1]);
    }
    return out;
  }
  while (indices.length > 3) {
    let found = false;
    for (let i = 0; i < indices.length; i++) {
      const ia = indices[(i + indices.length - 1) % indices.length],
        ib = indices[i],
        ic = indices[(i + 1) % indices.length];
      const a = p[ia],
        b = p[ib],
        c = p[ic];
      if (cross(a, b, c) * sign <= epsilon) continue;
      if (
        indices.some(
          (k) =>
            k !== ia &&
            k !== ib &&
            k !== ic &&
            cross(a, b, p[k]) * sign >= -epsilon &&
            cross(b, c, p[k]) * sign >= -epsilon &&
            cross(c, a, p[k]) * sign >= -epsilon,
        )
      )
        continue;
      out.push(...a, ...b, ...c);
      indices.splice(i, 1);
      found = true;
      break;
    }
    if (!found) {
      const collinear = indices.findIndex(
        (k, i) =>
          Math.abs(
            cross(
              p[indices[(i + indices.length - 1) % indices.length]],
              p[k],
              p[indices[(i + 1) % indices.length]],
            ),
          ) <= epsilon,
      );
      if (collinear >= 0) {
        indices.splice(collinear, 1);
        continue;
      }
      throw new Error(
        "Cannot triangulate polygon: use a simple outline without crossings",
      );
    }
  }
  if (
    indices.length === 3 &&
    Math.abs(cross(p[indices[0]], p[indices[1]], p[indices[2]])) > epsilon
  )
    out.push(...p[indices[0]], ...p[indices[1]], ...p[indices[2]]);
  return out;
}

/** Retained, resolution-independent filled geometry. Tessellated once, rendered on every backend. */
export class Graphics2D extends Node2D {
  private shapes: Shape[] = [];
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  get triangleCount(): number {
    return this.shapes.reduce((n, s) => n + s.positions.length / 6, 0);
  }
  clearGraphics(): this {
    this.shapes.length = 0;
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
    return this;
  }
  polygon(points: readonly Point2D[], fill: number | Fill2D): this {
    const positions = triangulatePolygon(points);
    if (!positions.length) return this;
    for (let i = 0; i < positions.length; i += 2) {
      this.minX = Math.min(this.minX, positions[i]);
      this.maxX = Math.max(this.maxX, positions[i]);
      this.minY = Math.min(this.minY, positions[i + 1]);
      this.maxY = Math.max(this.maxY, positions[i + 1]);
    }
    this.shapes.push({
      positions,
      vertices: new Float32Array(positions.length * 2),
      fill: typeof fill === "number" ? { color: fill } : { ...fill },
      u: NaN,
      v: NaN,
    });
    return this;
  }
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    fill: number | Fill2D,
  ): this {
    return this.polygon(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      fill,
    );
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    fill: number | Fill2D,
    segments = 28,
  ): this {
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < 0 || ry < 0)
      throw new Error("Ellipse radii must be finite and nonnegative");
    const n = Math.max(8, Math.min(128, Math.floor(segments) || 28));
    return this.polygon(
      Array.from(
        { length: n },
        (_, i) =>
          [
            x + Math.cos((i / n) * Math.PI * 2) * rx,
            y + Math.sin((i / n) * Math.PI * 2) * ry,
          ] as Point2D,
      ),
      fill,
    );
  }
  roundedRect(
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    fill: number | Fill2D,
  ): this {
    if (![x, y, w, h, radius].every(Number.isFinite) || radius < 0)
      throw new Error(
        "Rounded rectangle values must be finite and radius nonnegative",
      );
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    const r = Math.min(radius, w / 2, h / 2);
    if (r === 0) return this.rect(x, y, w, h, fill);
    const points: Point2D[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const cx = corner === 0 || corner === 3 ? x + w - r : x + r;
      const cy = corner < 2 ? y + h - r : y + r;
      for (let i = 0; i <= 6; i++) {
        const a = ((corner + i / 6) * Math.PI) / 2;
        points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
    }
    return this.polygon(points, fill);
  }
  /** Round-capped connected strokes. Segment overlap is intended; use opaque fills for uniform joints. */
  polyline(
    points: readonly Point2D[],
    width: number,
    fill: number | Fill2D,
  ): this {
    if (!Number.isFinite(width) || width <= 0)
      throw new Error("Stroke width must be positive");
    if (points.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
      throw new Error("Stroke coordinates must be finite");
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!d) continue;
      const nx = ((-(b[1] - a[1]) / d) * width) / 2,
        ny = (((b[0] - a[0]) / d) * width) / 2;
      this.polygon(
        [
          [a[0] + nx, a[1] + ny],
          [b[0] + nx, b[1] + ny],
          [b[0] - nx, b[1] - ny],
          [a[0] - nx, a[1] - ny],
        ],
        fill,
      );
    }
    for (const p of points)
      this.ellipse(p[0], p[1], width / 2, width / 2, fill, 12);
    return this;
  }
  override render(ctx: DrawContext): void {
    if (!this.shapes.length) return;
    // Bounding box in screen space; handles rotation, reflection and projected node transforms.
    if (ctx.cull) {
      const m = ctx.transform,
        cx = (this.minX + this.maxX) / 2,
        cy = (this.minY + this.maxY) / 2;
      const x = m[0] * cx + m[2] * cy + m[4],
        y = m[1] * cx + m[3] * cy + m[5];
      const ex =
        (Math.abs(m[0]) * (this.maxX - this.minX)) / 2 +
        (Math.abs(m[2]) * (this.maxY - this.minY)) / 2;
      const ey =
        (Math.abs(m[1]) * (this.maxX - this.minX)) / 2 +
        (Math.abs(m[3]) * (this.maxY - this.minY)) / 2;
      if (x + ex < 0 || y + ey < 0 || x - ex > ctx.width || y - ey > ctx.height)
        return;
    }
    for (const s of this.shapes) {
      if (s.u !== ctx.atlas.whiteU || s.v !== ctx.atlas.whiteV) {
        s.u = ctx.atlas.whiteU;
        s.v = ctx.atlas.whiteV;
        for (let i = 0; i < s.positions.length / 2; i++) {
          s.vertices[i * 4] = s.positions[i * 2];
          s.vertices[i * 4 + 1] = s.positions[i * 2 + 1];
          s.vertices[i * 4 + 2] = s.u;
          s.vertices[i * 4 + 3] = s.v;
        }
      }
      ctx.mesh(s.vertices, s.positions.length / 2, {
        tint: s.fill.color,
        alpha: s.fill.alpha,
        additive: s.fill.additive,
      });
    }
  }
}
