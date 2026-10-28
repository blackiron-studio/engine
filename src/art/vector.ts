// Anti-aliased vector painting on a Painter: paths (lines, quadratic and cubic curves, arcs),
// exact-coverage fills (nonzero or even-odd), round-capped strokes, linear / radial / conic
// gradients, per-pixel shaders, blend modes, blur, drop and inner shadows, and bevels. This
// is what lifts procedural art from blocky pixels to smooth, high-resolution illustration.
//
// Coordinates are logical units: a Pen draws through the painter's `density` (texels per
// unit), so the same drawing code paints a crisp 2x or 4x sprite. Pixel-level Painter methods
// (px, rect, ...) keep working in raw texels.

import { type ColorInput, parseColor } from "./color.ts";
import type { Painter } from "./painter.ts";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "add"
  | "darken"
  | "lighten"
  /** Paint only where the painter is already opaque, keeping its alpha (source-atop). */
  | "inside"
  /** Paint underneath what is there (destination-over). */
  | "behind"
  /** Remove coverage (destination-out). */
  | "erase";

export type GradientStops = ReadonlyArray<readonly [number, ColorInput]>;

export interface LinearGradient {
  kind: "linear";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stops: GradientStops;
}

export interface RadialGradient {
  kind: "radial";
  cx: number;
  cy: number;
  r: number;
  /** Vertical radius for an elliptical gradient; defaults to r. */
  ry?: number;
  stops: GradientStops;
}

export interface ConicGradient {
  kind: "conic";
  cx: number;
  cy: number;
  /** Start angle in radians. */
  angle: number;
  stops: GradientStops;
}

/** A per-pixel colour function in pen coordinates: returns [r, g, b, a] in 0..255. */
export type ShaderFn = (x: number, y: number) => readonly [number, number, number, number];

export type Paint = ColorInput | LinearGradient | RadialGradient | ConicGradient | ShaderFn;

export const linear = (x0: number, y0: number, x1: number, y1: number, stops: GradientStops): LinearGradient => ({ kind: "linear", x0, y0, x1, y1, stops });
export const radial = (cx: number, cy: number, r: number, stops: GradientStops, ry?: number): RadialGradient => ({ kind: "radial", cx, cy, r, ry, stops });
export const conic = (cx: number, cy: number, angle: number, stops: GradientStops): ConicGradient => ({ kind: "conic", cx, cy, angle, stops });

// ------------------------------------------------------------------------------- paths

type Cmd = { op: "M" | "L"; x: number; y: number } | { op: "Q"; cx: number; cy: number; x: number; y: number } | { op: "C"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number } | { op: "Z" };

/** A vector path. Methods chain; shapes add closed subpaths. */
export class Path {
  readonly cmds: Cmd[] = [];
  private sx = 0;
  private sy = 0;
  private cx = 0;
  private cy = 0;

  moveTo(x: number, y: number): this {
    this.cmds.push({ op: "M", x, y });
    this.sx = this.cx = x;
    this.sy = this.cy = y;
    return this;
  }

  lineTo(x: number, y: number): this {
    if (this.cmds.length === 0) return this.moveTo(x, y);
    this.cmds.push({ op: "L", x, y });
    this.cx = x;
    this.cy = y;
    return this;
  }

  quadTo(cx: number, cy: number, x: number, y: number): this {
    this.cmds.push({ op: "Q", cx, cy, x, y });
    this.cx = x;
    this.cy = y;
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    this.cmds.push({ op: "C", c1x, c1y, c2x, c2y, x, y });
    this.cx = x;
    this.cy = y;
    return this;
  }

  close(): this {
    this.cmds.push({ op: "Z" });
    this.cx = this.sx;
    this.cy = this.sy;
    return this;
  }

  /** An arc of a circle from angle a0 to a1 (radians, clockwise on screen when a1 > a0). Joins the current point with a line. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number): this {
    return this.ellipseArc(cx, cy, r, r, a0, a1);
  }

  ellipseArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): this {
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
    const da = (a1 - a0) / steps;
    const k = (4 / 3) * Math.tan(da / 4);
    let x = cx + Math.cos(a0) * rx;
    let y = cy + Math.sin(a0) * ry;
    if (this.cmds.length === 0 || this.cmds[this.cmds.length - 1].op === "Z") this.moveTo(x, y);
    else this.lineTo(x, y);
    for (let i = 0; i < steps; i++) {
      const t0 = a0 + da * i;
      const t1 = t0 + da;
      const x1 = cx + Math.cos(t1) * rx;
      const y1 = cy + Math.sin(t1) * ry;
      this.cubicTo(x - Math.sin(t0) * rx * k, y + Math.cos(t0) * ry * k, x1 + Math.sin(t1) * rx * k, y1 - Math.cos(t1) * ry * k, x1, y1);
      x = x1;
      y = y1;
    }
    return this;
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    this.moveTo(cx + rx, cy);
    this.ellipseArc(cx, cy, rx, ry, 0, Math.PI * 2);
    return this.close();
  }

  circle(cx: number, cy: number, r: number): this {
    return this.ellipse(cx, cy, r, r);
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.moveTo(x, y).lineTo(x + w, y).lineTo(x + w, y + h).lineTo(x, y + h).close();
  }

  /** A rounded rectangle; `r` is one radius or [top-left, top-right, bottom-right, bottom-left]. */
  roundRect(x: number, y: number, w: number, h: number, r: number | readonly [number, number, number, number]): this {
    const lim = Math.min(w, h) / 2;
    const [tl, tr, br, bl] = (typeof r === "number" ? [r, r, r, r] : r).map((v) => Math.max(0, Math.min(lim, v)));
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    if (tr > 0) this.ellipseArc(x + w - tr, y + tr, tr, tr, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - br);
    if (br > 0) this.ellipseArc(x + w - br, y + h - br, br, br, 0, Math.PI / 2);
    this.lineTo(x + bl, y + h);
    if (bl > 0) this.ellipseArc(x + bl, y + h - bl, bl, bl, Math.PI / 2, Math.PI);
    this.lineTo(x, y + tl);
    if (tl > 0) this.ellipseArc(x + tl, y + tl, tl, tl, Math.PI, Math.PI * 1.5);
    return this.close();
  }

  polygon(points: ReadonlyArray<readonly [number, number]>): this {
    points.forEach(([x, y], i) => (i === 0 ? this.moveTo(x, y) : this.lineTo(x, y)));
    return this.close();
  }

  /** A smooth closed curve through the points (Catmull-Rom), for leaves, clouds, blobs. */
  smoothPolygon(points: ReadonlyArray<readonly [number, number]>, tension = 1): this {
    const n = points.length;
    if (n < 3) return this.polygon(points);
    const p = (i: number) => points[((i % n) + n) % n];
    this.moveTo(p(0)[0], p(0)[1]);
    for (let i = 0; i < n; i++) {
      const [x0, y0] = p(i - 1);
      const [x1, y1] = p(i);
      const [x2, y2] = p(i + 1);
      const [x3, y3] = p(i + 2);
      const t = tension / 6;
      this.cubicTo(x1 + (x2 - x0) * t, y1 + (y2 - y0) * t, x2 - (x3 - x1) * t, y2 - (y3 - y1) * t, x2, y2);
    }
    return this.close();
  }

  /** A star or regular polygon (inner = outer) with `n` points. */
  star(cx: number, cy: number, outer: number, inner: number, n: number, rotation = -Math.PI / 2): this {
    const pts: [number, number][] = [];
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = rotation + (i * Math.PI) / n;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return this.polygon(pts);
  }

  /** Flatten into polylines in the coordinates `map` returns; `tol` is the max error after mapping. */
  flatten(map: (x: number, y: number) => [number, number], tol = 0.2): { pts: number[]; closed: boolean }[] {
    const out: { pts: number[]; closed: boolean }[] = [];
    let cur: number[] | null = null;
    let lx = 0;
    let ly = 0;
    const push = (x: number, y: number) => {
      const [mx, my] = map(x, y);
      cur!.push(mx, my);
    };
    for (const c of this.cmds) {
      if (c.op === "M") {
        if (cur && cur.length > 2) out.push({ pts: cur, closed: false });
        cur = [];
        push(c.x, c.y);
        lx = c.x;
        ly = c.y;
      } else if (c.op === "L") {
        if (!cur) cur = [];
        push(c.x, c.y);
        lx = c.x;
        ly = c.y;
      } else if (c.op === "Q" || c.op === "C") {
        if (!cur) cur = [];
        const [ax, ay] = map(lx, ly);
        const [bx, by] = map(c.x, c.y);
        const ctrl = c.op === "Q" ? [map(c.cx, c.cy)] : [map(c.c1x, c.c1y), map(c.c2x, c.c2y)];
        let len = Math.hypot(bx - ax, by - ay);
        let prev = [ax, ay];
        for (const q of ctrl) {
          len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
          prev = q;
        }
        const n = Math.min(256, Math.max(2, Math.ceil(Math.sqrt(len / tol) * 1.2)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          let x: number;
          let y: number;
          if (c.op === "Q") {
            x = u * u * lx + 2 * u * t * c.cx + t * t * c.x;
            y = u * u * ly + 2 * u * t * c.cy + t * t * c.y;
          } else {
            x = u * u * u * lx + 3 * u * u * t * c.c1x + 3 * u * t * t * c.c2x + t * t * t * c.x;
            y = u * u * u * ly + 3 * u * u * t * c.c1y + 3 * u * t * t * c.c2y + t * t * t * c.y;
          }
          push(x, y);
        }
        lx = c.x;
        ly = c.y;
      } else if (c.op === "Z") {
        if (cur && cur.length > 2) out.push({ pts: cur, closed: true });
        cur = null;
      }
    }
    if (cur && cur.length > 2) out.push({ pts: cur, closed: false });
    return out;
  }
}

/** Start a new path. */
export const path = (): Path => new Path();

// --------------------------------------------------------------------------- coverage

interface Coverage {
  x0: number;
  y0: number;
  w: number;
  h: number;
  cov: Float32Array;
}

const SUB = 16;

/** Exact horizontal, 16-sample vertical area coverage of closed polygons in texel space. */
function fillCoverage(polys: { pts: number[] }[], width: number, height: number, evenOdd: boolean): Coverage | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const edges: number[] = []; // x0, y0, x1, y1, dir
  for (const { pts } of polys) {
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = pts[i * 2];
      const ay = pts[i * 2 + 1];
      const j = (i + 1) % n;
      const bx = pts[j * 2];
      const by = pts[j * 2 + 1];
      minX = Math.min(minX, ax);
      maxX = Math.max(maxX, ax);
      minY = Math.min(minY, ay);
      maxY = Math.max(maxY, ay);
      if (ay === by) continue;
      if (ay < by) edges.push(ax, ay, bx, by, 1);
      else edges.push(bx, by, ax, ay, -1);
    }
  }
  if (!edges.length) return null;
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(width, Math.ceil(maxX) + 1);
  const y1 = Math.min(height, Math.ceil(maxY) + 1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const cov = new Float32Array(w * h);
  const count = edges.length / 5;
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => edges[a * 5 + 1] - edges[b * 5 + 1]);
  const active: number[] = [];
  let next = 0;
  const xs: number[] = [];
  const diff = new Float32Array(w + 2);
  const direct = new Float32Array(w + 2);
  const s = 1 / SUB;
  const span = (xa: number, xb: number) => {
    xa = Math.max(x0, Math.min(x1, xa)) - x0;
    xb = Math.max(x0, Math.min(x1, xb)) - x0;
    if (xb <= xa) return;
    const ia = Math.floor(xa);
    const ib = Math.floor(xb);
    if (ia === ib) {
      direct[ia] += (xb - xa) * s;
      return;
    }
    direct[ia] += (ia + 1 - xa) * s;
    diff[ia + 1] += s;
    diff[ib] -= s;
    if (ib < w + 1) direct[ib] += (xb - ib) * s;
  };
  for (let row = y0; row < y1; row++) {
    diff.fill(0);
    direct.fill(0);
    for (let k = 0; k < SUB; k++) {
      const y = row + (k + 0.5) / SUB;
      while (next < count && edges[order[next] * 5 + 1] <= y) active.push(order[next++]);
      xs.length = 0;
      for (let a = active.length - 1; a >= 0; a--) {
        const e = active[a] * 5;
        if (edges[e + 3] <= y) {
          active.splice(a, 1);
          continue;
        }
        if (edges[e + 1] > y) continue;
        const t = (y - edges[e + 1]) / (edges[e + 3] - edges[e + 1]);
        xs.push(edges[e] + (edges[e + 2] - edges[e]) * t, edges[e + 4]);
      }
      if (xs.length < 4) continue;
      const idx = Array.from({ length: xs.length / 2 }, (_, i) => i).sort((a, b) => xs[a * 2] - xs[b * 2]);
      let wind = 0;
      let start = 0;
      for (const i of idx) {
        const x = xs[i * 2];
        const before = evenOdd ? wind & 1 : wind;
        wind += evenOdd ? 1 : xs[i * 2 + 1];
        const after = evenOdd ? wind & 1 : wind;
        if (before === 0 && after !== 0) start = x;
        else if (before !== 0 && after === 0) span(start, x);
      }
    }
    let run = 0;
    const base = (row - y0) * w;
    for (let i = 0; i < w; i++) {
      run += diff[i];
      cov[base + i] = Math.min(1, run + direct[i]);
    }
  }
  return { x0, y0, w, h, cov };
}

/** Union of round-capped capsules of half-width `hw` along polylines, in texel space. */
function strokeCoverage(lines: { pts: number[]; closed: boolean }[], hw: number, width: number, height: number): Coverage | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { pts } of lines) {
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]);
      maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]);
      maxY = Math.max(maxY, pts[i + 1]);
    }
  }
  const pad = hw + 1;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(width, Math.ceil(maxX + pad));
  const y1 = Math.min(height, Math.ceil(maxY + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const cov = new Float32Array(w * h);
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - pad));
    const sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - pad));
    const sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + pad));
    const sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + pad));
    const dx = bx - ax;
    const dy = by - ay;
    const ll = dx * dx + dy * dy;
    for (let y = sy0; y < sy1; y++) {
      const py = y + 0.5;
      for (let x = sx0; x < sx1; x++) {
        const px = x + 0.5;
        let t = ll > 0 ? ((px - ax) * dx + (py - ay) * dy) / ll : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        const c = hw - d + 0.5;
        if (c <= 0) continue;
        const i = (y - y0) * w + (x - x0);
        const v = c > 1 ? 1 : c;
        if (v > cov[i]) cov[i] = v;
      }
    }
  };
  for (const { pts, closed } of lines) {
    const n = pts.length / 2;
    for (let i = 0; i + 1 < n; i++) seg(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3]);
    if (closed && n > 2) seg(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], pts[0], pts[1]);
    if (n === 1) seg(pts[0], pts[1], pts[0], pts[1]);
  }
  return { x0, y0, w, h, cov };
}

// ----------------------------------------------------------------------------- paints

type Sampler = (x: number, y: number, out: Float32Array) => void;

function stopsLut(stops: GradientStops): Float32Array {
  const lut = new Float32Array(256 * 4);
  const s = [...stops].sort((a, b) => a[0] - b[0]).map(([t, c]) => [t, parseColor(c)] as const);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < s.length - 1 && s[k + 1][0] < t) k++;
    const [ta, ca] = s[k];
    const [tb, cb] = s[Math.min(k + 1, s.length - 1)];
    const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    // Interpolate premultiplied so fades to transparent do not darken.
    const aa = ca.a / 255;
    const ab = cb.a / 255;
    const a = aa + (ab - aa) * f;
    const pr = ca.r * aa + (cb.r * ab - ca.r * aa) * f;
    const pg = ca.g * aa + (cb.g * ab - ca.g * aa) * f;
    const pb = ca.b * aa + (cb.b * ab - ca.b * aa) * f;
    lut[i * 4] = a > 0 ? pr / a : ca.r;
    lut[i * 4 + 1] = a > 0 ? pg / a : ca.g;
    lut[i * 4 + 2] = a > 0 ? pb / a : ca.b;
    lut[i * 4 + 3] = a * 255;
  }
  return lut;
}

function sampler(paint: Paint): Sampler {
  if (typeof paint === "function") {
    return (x, y, out) => {
      const c = paint(x, y);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      out[3] = c[3];
    };
  }
  if (typeof paint === "string" || typeof paint === "number") {
    const c = parseColor(paint);
    return (_x, _y, out) => {
      out[0] = c.r;
      out[1] = c.g;
      out[2] = c.b;
      out[3] = c.a;
    };
  }
  const lut = stopsLut(paint.stops);
  const read = (t: number, out: Float32Array) => {
    const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 4;
    out[0] = lut[i];
    out[1] = lut[i + 1];
    out[2] = lut[i + 2];
    out[3] = lut[i + 3];
  };
  if (paint.kind === "linear") {
    const dx = paint.x1 - paint.x0;
    const dy = paint.y1 - paint.y0;
    const ll = dx * dx + dy * dy || 1;
    return (x, y, out) => read(((x - paint.x0) * dx + (y - paint.y0) * dy) / ll, out);
  }
  if (paint.kind === "radial") {
    const ry = paint.ry ?? paint.r;
    return (x, y, out) => read(Math.hypot((x - paint.cx) / paint.r, (y - paint.cy) / ry), out);
  }
  return (x, y, out) => {
    let a = (Math.atan2(y - paint.cy, x - paint.cx) - paint.angle) / (Math.PI * 2);
    a -= Math.floor(a);
    read(a, out);
  };
}

// ---------------------------------------------------------------------------- blending

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

function mixChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "multiply":
      return cb * cs;
    case "screen":
      return cb + cs - cb * cs;
    case "overlay":
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "soft-light":
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * ((cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb)) - cb);
    case "add":
      return Math.min(1, cb + cs);
    case "darken":
      return Math.min(cb, cs);
    case "lighten":
      return Math.max(cb, cs);
    default:
      return cs;
  }
}

/** Composite one straight-alpha colour (0..255, alpha 0..1) into data[i] with a blend mode. */
export function blendInto(d: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number, mode: BlendMode): void {
  if (a <= 0) return;
  const ab = d[i + 3] / 255;
  if (mode === "erase") {
    d[i + 3] = ab * (1 - a) * 255;
    return;
  }
  if (mode === "behind") {
    const oa = ab + a * (1 - ab);
    if (oa <= 0) return;
    d[i] = (d[i] * ab + r * a * (1 - ab)) / oa;
    d[i + 1] = (d[i + 1] * ab + g * a * (1 - ab)) / oa;
    d[i + 2] = (d[i + 2] * ab + b * a * (1 - ab)) / oa;
    d[i + 3] = oa * 255;
    return;
  }
  if (mode === "inside") {
    if (ab <= 0) return;
    d[i] = clamp255(d[i] + (r - d[i]) * a);
    d[i + 1] = clamp255(d[i + 1] + (g - d[i + 1]) * a);
    d[i + 2] = clamp255(d[i + 2] + (b - d[i + 2]) * a);
    return;
  }
  let sr = r;
  let sg = g;
  let sb = b;
  if (mode !== "normal" && ab > 0) {
    // W3C separable blending: the source takes the blended colour where the backdrop exists.
    const br = d[i] / 255;
    const bg = d[i + 1] / 255;
    const bb = d[i + 2] / 255;
    sr = ((1 - ab) * (r / 255) + ab * mixChannel(mode, br, r / 255)) * 255;
    sg = ((1 - ab) * (g / 255) + ab * mixChannel(mode, bg, g / 255)) * 255;
    sb = ((1 - ab) * (b / 255) + ab * mixChannel(mode, bb, b / 255)) * 255;
  }
  const oa = a + ab * (1 - a);
  if (oa <= 0) return;
  d[i] = clamp255((sr * a + d[i] * ab * (1 - a)) / oa);
  d[i + 1] = clamp255((sg * a + d[i + 1] * ab * (1 - a)) / oa);
  d[i + 2] = clamp255((sb * a + d[i + 2] * ab * (1 - a)) / oa);
  d[i + 3] = oa * 255;
}

// --------------------------------------------------------------------------------- pen

export interface PaintOptions {
  opacity?: number;
  blend?: BlendMode;
}

export interface FillOptions extends PaintOptions {
  rule?: "nonzero" | "evenodd";
}

export interface StrokeOptions extends PaintOptions {}

type M = [number, number, number, number, number, number];

/**
 * Draws vector shapes onto a Painter in logical units, through a transform stack. Obtain one
 * with `pen(painter)`; all shapes are anti-aliased.
 */
export class Pen {
  private m: M;
  private stack: M[] = [];
  private readonly tmp = new Float32Array(4);

  constructor(
    readonly painter: Painter,
    density = painter.density,
  ) {
    this.m = [density, 0, 0, density, 0, 0];
  }

  save(): this {
    this.stack.push([...this.m] as M);
    return this;
  }

  restore(): this {
    const m = this.stack.pop();
    if (m) this.m = m;
    return this;
  }

  /** Run `fn` with the transform saved and restored around it. */
  with(fn: () => void): this {
    this.save();
    try {
      fn();
    } finally {
      this.restore();
    }
    return this;
  }

  translate(x: number, y: number): this {
    const m = this.m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
    return this;
  }

  scale(sx: number, sy = sx): this {
    const m = this.m;
    m[0] *= sx;
    m[1] *= sx;
    m[2] *= sy;
    m[3] *= sy;
    return this;
  }

  rotate(a: number): this {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const [a0, b0, c0, d0] = this.m;
    this.m[0] = a0 * c + c0 * s;
    this.m[1] = b0 * c + d0 * s;
    this.m[2] = c0 * c - a0 * s;
    this.m[3] = d0 * c - b0 * s;
    return this;
  }

  /** The current transform's scale (texels per unit along x), for density-aware detail. */
  get unit(): number {
    return Math.hypot(this.m[0], this.m[1]);
  }

  private map = (x: number, y: number): [number, number] => {
    const m = this.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  };

  private composite(c: Coverage | null, paint: Paint, o: PaintOptions): void {
    if (!c) return;
    const p = this.painter;
    const d = p.data;
    const mask = p.maskData;
    const sample = sampler(paint);
    const opacity = o.opacity ?? 1;
    const mode = o.blend ?? "normal";
    const m = this.m;
    const det = m[0] * m[3] - m[1] * m[2] || 1;
    const ia = m[3] / det;
    const ib = -m[1] / det;
    const ic = -m[2] / det;
    const id = m[0] / det;
    const ie = (m[2] * m[5] - m[3] * m[4]) / det;
    const iff = (m[1] * m[4] - m[0] * m[5]) / det;
    const out = this.tmp;
    for (let y = 0; y < c.h; y++) {
      const ty = c.y0 + y + 0.5;
      for (let x = 0; x < c.w; x++) {
        const cov = c.cov[y * c.w + x];
        if (cov <= 0.001) continue;
        const tx = c.x0 + x + 0.5;
        const i = ((c.y0 + y) * p.width + (c.x0 + x)) * 4;
        if (mask && mask[i + 3] === 0) continue;
        sample(ia * tx + ic * ty + ie, ib * tx + id * ty + iff, out);
        const a = (out[3] / 255) * cov * opacity * (mask ? mask[i + 3] / 255 : 1);
        blendInto(d, i, out[0], out[1], out[2], a, mode);
      }
    }
  }

  fill(shape: Path, paint: Paint, o: FillOptions = {}): this {
    const tol = 0.2;
    const polys = shape.flatten(this.map, tol);
    this.composite(fillCoverage(polys, this.painter.width, this.painter.height, o.rule === "evenodd"), paint, o);
    return this;
  }

  /** Stroke with round joins and caps; `width` is in logical units. */
  stroke(shape: Path, width: number, paint: Paint, o: StrokeOptions = {}): this {
    const lines = shape.flatten(this.map, 0.2);
    this.composite(strokeCoverage(lines, (width * this.unit) / 2, this.painter.width, this.painter.height), paint, o);
    return this;
  }

  circle(cx: number, cy: number, r: number, paint: Paint, o: FillOptions = {}): this {
    return this.fill(path().circle(cx, cy, r), paint, o);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, paint: Paint, o: FillOptions = {}): this {
    return this.fill(path().ellipse(cx, cy, rx, ry), paint, o);
  }

  rect(x: number, y: number, w: number, h: number, paint: Paint, o: FillOptions = {}): this {
    return this.fill(path().rect(x, y, w, h), paint, o);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number | readonly [number, number, number, number], paint: Paint, o: FillOptions = {}): this {
    return this.fill(path().roundRect(x, y, w, h, r), paint, o);
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, paint: Paint, o: StrokeOptions = {}): this {
    return this.stroke(path().moveTo(x0, y0).lineTo(x1, y1), width, paint, o);
  }

  /** A ring (annulus) from radius r - width/2 to r + width/2. */
  ring(cx: number, cy: number, r: number, width: number, paint: Paint, o: PaintOptions = {}): this {
    return this.fill(path().circle(cx, cy, r + width / 2).circle(cx, cy, Math.max(0, r - width / 2)), paint, { ...o, rule: "evenodd" });
  }

  /** Cover the whole painter with a paint (a background, a texture, a gradient wash). */
  flood(paint: Paint, o: PaintOptions = {}): this {
    const p = this.painter;
    const c: Coverage = { x0: 0, y0: 0, w: p.width, h: p.height, cov: new Float32Array(p.width * p.height).fill(1) };
    this.composite(c, paint, o);
    return this;
  }
}

/** A pen drawing on `painter` in logical units at its density. */
export const pen = (painter: Painter): Pen => new Pen(painter);
