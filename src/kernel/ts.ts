// The reference kernel in TypeScript: the same semantics as kernel/src/lib.rs, used in
// tests, in headless runs, and as the fallback when no compiled kernel is available. Keep
// the two in step; tests/kernel.test.ts checks that they produce identical output.

import { Rng } from "../core/rng.ts";
import { BATCH_STRIDE, BATCH3_STRIDE, commandWords, CFG, FLOATS_PER_VERT, FRAME_WORDS, type Kernel, type KernelOptions, DEFAULT_MAX_QUADS, DEFAULT_STREAM_WORDS, NODE as N, NODE_BOUNDS, NODE_FLAG as F, NODE_FLOOR, NODE_WORDS, OP, STAT } from "./protocol.ts";

/** Blend (bits 0-1) plus material (bits 5-8) of a flags word, packed as the vertex mode. */
const modeOf = (flags: number): number => (flags & 3) + ((flags >> 5) & 15) * 4;
const slotOf = (flags: number): number => (flags >> 2) & 7;
const TAU = Math.PI * 2;
export const CMD = { BEGIN: 1, PASS: 2, DRAW: 3, END: 4, SCISSOR: 5 } as const;

interface Batch {
  data: Float32Array;
  count: number;
  capacity: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  spin: number;
  color: number;
}

interface Emitter {
  rate: number;
  life: [number, number];
  speed: [number, number];
  angle: [number, number];
  gravity: number;
  drag: number;
  size: [number, number];
  sizeEnd: number;
  alpha: [number, number];
  spread: number;
  spin: number;
  max: number;
  additive: boolean;
  sprite: { w: number; h: number; ox: number; oy: number; u0: number; v0: number; u1: number; v1: number } | null;
  colors: number[];
  rng: Rng;
  acc: number;
  live: Particle[];
}

const jsRound = Math.round;

interface Frame {
  w: number;
  h: number;
  ox: number;
  oy: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** The reference node table; kernel/src/nodes.rs is the compiled twin. */
class NodeTable {
  readonly data: Float32Array;
  readonly capacity: number;
  private free: number[];
  high = 0;
  live = 0;
  gravity: [number, number] = [0, 0];
  damping = 0;
  boundsMode = 0;
  bounds: [number, number, number, number] = [0, 0, 0, 0];
  frames: Frame[] = [];
  gravityZ = 0;
  floor = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.data = new Float32Array(this.capacity * NODE_WORDS);
    this.free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
  }

  alloc(): number {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const o = i * NODE_WORDS;
    this.data.fill(0, o, o + NODE_WORDS);
    this.data[o + N.SX] = 1;
    this.data[o + N.SY] = 1;
    this.data[o + N.TINT] = 0xffffff;
    this.data[o + N.ALPHA] = 1;
    this.data[o + N.FLAGS] = F.ALIVE;
    this.data[o + N.BODY] = -1;
    this.live++;
    this.high = Math.max(this.high, i + 1);
    return i;
  }

  freeNode(index: number): void {
    if (index < 0 || index >= this.capacity) return;
    const o = index * NODE_WORDS;
    if ((this.data[o + N.FLAGS] & F.ALIVE) === 0) return;
    this.data[o + N.FLAGS] = 0;
    this.free.push(index);
    this.live--;
  }

  clear(): void {
    for (let i = 0; i < this.high; i++) this.data[i * NODE_WORDS + N.FLAGS] = 0;
    this.free = [];
    for (let i = this.capacity - 1; i >= 0; i--) this.free.push(i);
    this.live = 0;
    this.high = 0;
  }

  step(dt: number): void {
    const [gx, gy] = this.gravity;
    const damp = this.damping > 0 ? Math.max(0, 1 - this.damping * dt) : 1;
    const mode = this.boundsMode;
    const [bx, by, bw, bh] = this.bounds;
    const d = this.data;
    const toFree: number[] = [];
    for (let i = 0; i < this.high; i++) {
      const o = i * NODE_WORDS;
      const flags = d[o + N.FLAGS];
      if ((flags & F.ALIVE) === 0) continue;
      if (flags & F.EXPIRES) {
        const life = d[o + N.LIFE] - dt;
        d[o + N.LIFE] = life;
        if (life <= 0) {
          toFree.push(i);
          continue;
        }
      }
      let vx = d[o + N.VX] + gx * dt;
      let vy = d[o + N.VY] + gy * dt;
      vx *= damp;
      vy *= damp;
      let x = d[o + N.X] + vx * dt;
      let y = d[o + N.Y] + vy * dt;
      d[o + N.ROT] = d[o + N.ROT] + d[o + N.VROT] * dt;
      if (mode === NODE_BOUNDS.WRAP && bw > 0 && bh > 0) {
        if (x < bx) x += bw;
        else if (x >= bx + bw) x -= bw;
        if (y < by) y += bh;
        else if (y >= by + bh) y -= bh;
      } else if (mode === NODE_BOUNDS.BOUNCE && bw > 0 && bh > 0) {
        if (x < bx) {
          x = bx;
          vx = Math.abs(vx);
        } else if (x > bx + bw) {
          x = bx + bw;
          vx = -Math.abs(vx);
        }
        if (y < by) {
          y = by;
          vy = Math.abs(vy);
        } else if (y > by + bh) {
          y = by + bh;
          vy = -Math.abs(vy);
        }
      } else if (mode === NODE_BOUNDS.KILL && bw > 0 && bh > 0) {
        if (x < bx || x > bx + bw || y < by || y > by + bh) {
          toFree.push(i);
          continue;
        }
      }
      d[o + N.X] = x;
      d[o + N.Y] = y;
      d[o + N.VX] = vx;
      d[o + N.VY] = vy;
      // Height: its own velocity and gravity, with a floor at zero.
      let vz = d[o + N.VZ] + this.gravityZ * dt;
      let z = d[o + N.Z] + vz * dt;
      if (z < 0 && this.floor !== NODE_FLOOR.NONE) {
        z = 0;
        vz = this.floor === NODE_FLOOR.BOUNCE && vz < -30 ? -vz * 0.55 : 0;
      }
      d[o + N.Z] = z;
      d[o + N.VZ] = vz;
      const count = d[o + N.FRAME_COUNT];
      const fps = d[o + N.FPS];
      if (count > 1 && fps !== 0) {
        let f = d[o + N.FRAME] + fps * dt;
        f %= count;
        if (f < 0) f += count;
        d[o + N.FRAME] = f;
      }
    }
    for (const i of toFree) this.freeNode(i);
  }

  applyTransforms(t: Float32Array): number {
    const bodies = Math.floor(t.length / 8);
    if (bodies === 0) return 0;
    let maxId = 0;
    for (let k = 0; k < bodies; k++) maxId = Math.max(maxId, Math.max(0, t[k * 8]));
    const byId = new Int32Array(maxId + 1).fill(-1);
    for (let k = 0; k < bodies; k++) if (t[k * 8] >= 0) byId[t[k * 8]] = k;
    const d = this.data;
    let moved = 0;
    for (let i = 0; i < this.high; i++) {
      const o = i * NODE_WORDS;
      if ((d[o + N.FLAGS] & F.ALIVE) === 0 || d[o + N.BODY] < 0) continue;
      const id = d[o + N.BODY];
      const k = id < byId.length ? byId[id] : -1;
      if (k < 0) continue;
      const b = k * 8;
      d[o + N.X] = t[b + 1];
      d[o + N.Y] = t[b + 2];
      d[o + N.ROT] = t[b + 3];
      d[o + N.VX] = t[b + 4];
      d[o + N.VY] = t[b + 5];
      d[o + N.VROT] = t[b + 6];
      moved++;
    }
    return moved;
  }
}

export class TsKernel implements Kernel {
  readonly kind = "ts" as const;
  readonly maxQuads: number;
  readonly stream: Float32Array;
  readonly scratch = new Float32Array(4096);
  readonly vertices: Float32Array;
  readonly commands: Uint32Array;
  readonly stats = new Uint32Array(STAT.COUNT);
  private quads = 0;
  private drawStart = 0;
  private m = [1, 0, 0, 1, 0, 0];
  private whiteU = 0;
  private whiteV = 0;
  private viewW = 0;
  private viewH = 0;
  private batches: (Batch | null)[] = [];
  private emitters: (Emitter | null)[] = [];
  private tables: (NodeTable | null)[] = [];
  private batches3: (Batch | null)[] = [];
  private proj: { p: number[]; cam: number[] } | null = null;
  private sorted = false;
  private pending: { key: number; seq: number; v: Float32Array }[] = [];
  private readonly pendingPool: { key: number; seq: number; v: Float32Array }[] = [];
  private readonly quadScratch = new Float32Array(4 * FLOATS_PER_VERT);
  private depthKey = 0;
  private ground: [number, number, number] = [0, 0, 0];
  private shadowRegion: { w: number; h: number; ox: number; oy: number; u0: number; v0: number; u1: number; v1: number } | null = null;

  constructor(opts: KernelOptions = {}) {
    this.maxQuads = Math.max(64, opts.maxQuads ?? DEFAULT_MAX_QUADS);
    this.stream = new Float32Array(Math.max(1024, opts.streamWords ?? DEFAULT_STREAM_WORDS));
    this.vertices = new Float32Array(this.maxQuads * 4 * FLOATS_PER_VERT);
    this.commands = new Uint32Array(this.maxQuads / 2 + 64);
  }

  setWhite(u: number, v: number): void {
    this.whiteU = u;
    this.whiteV = v;
  }

  setShadow(w: number, h: number, ox: number, oy: number, u0: number, v0: number, u1: number, v1: number): void {
    this.shadowRegion = w > 0 && h > 0 ? { w, h, ox, oy, u0, v0, u1, v1 } : null;
  }

  /** Screen position and depth of a ground point under the projection and camera. */
  private screenOf(x: number, y: number, z: number): [number, number, number] {
    const pr = this.proj as { p: number[]; cam: number[] };
    const p = pr.p;
    const sx = p[0] * x + p[1] * y + p[2] * z + p[3];
    const sy = p[4] * x + p[5] * y + p[6] * z + p[7];
    const depth = p[8] * x + p[9] * y + p[10] * z + p[11];
    const c = pr.cam;
    return [c[0] * sx + c[2] * sy + c[4], c[1] * sx + c[3] * sy + c[5], depth];
  }

  private transform3(a: number, b: number, c: number, d: number, gx: number, gy: number, gz: number, bias: number, shadow: boolean, shadowAlpha: number): void {
    this.ground = [gx, gy, gz];
    if (!this.proj) {
      this.m = [a, b, c, d, gx, gy - gz];
      this.depthKey = bias;
      return;
    }
    const [sx, sy, depth] = this.screenOf(gx, gy, gz);
    const cm = this.proj.cam;
    this.m = [cm[0] * a + cm[2] * b, cm[1] * a + cm[3] * b, cm[0] * c + cm[2] * d, cm[1] * c + cm[3] * d, sx, sy];
    this.depthKey = depth + bias;
    if (shadow) this.shadowAt(gx, gy, gz, shadowAlpha, bias);
  }

  private shadowAt(gx: number, gy: number, gz: number, alpha: number, bias: number): void {
    const sh = this.shadowRegion;
    if (!this.proj || !sh) return;
    const [sx, sy, depth] = this.screenOf(gx, gy, 0);
    const k = Math.max(0.4, 1 - gz / 160);
    const a = alpha * Math.max(0.2, 1 - gz / 200);
    const cm = this.proj.cam;
    const saved = this.depthKey;
    this.depthKey = depth + bias - 0.25;
    this.push(sx, sy, cm[0] * k, cm[1] * k, cm[2] * k, cm[3] * k, -sh.ox, -sh.oy, sh.w - sh.ox, sh.h - sh.oy, sh.u0, sh.v0, sh.u1, sh.v1, 1, 1, 1, a, 0, 0);
    this.depthKey = saved;
  }

  createBatch3(capacity: number): number {
    const cap = Math.max(1, capacity);
    const batch: Batch = { data: new Float32Array(cap * BATCH3_STRIDE), count: 0, capacity: cap };
    const slot = this.batches3.indexOf(null);
    if (slot >= 0) {
      this.batches3[slot] = batch;
      return slot;
    }
    this.batches3.push(batch);
    return this.batches3.length - 1;
  }

  batch3Data(id: number): Float32Array {
    return this.batches3[id]?.data ?? new Float32Array(0);
  }

  setBatch3Count(id: number, count: number): void {
    const b = this.batches3[id];
    if (b) b.count = Math.min(count, b.capacity);
  }

  destroyBatch3(id: number): void {
    if (id >= 0 && id < this.batches3.length) this.batches3[id] = null;
  }

  private drawBatch3(id: number, alphaMul: number, tintMul: number, flags: number): void {
    const b = this.batches3[id];
    if (!b) return;
    const mr = tintMul === 0xffffff ? 1 : ((tintMul >> 16) & 255) / 255;
    const mg = tintMul === 0xffffff ? 1 : ((tintMul >> 8) & 255) / 255;
    const mb = tintMul === 0xffffff ? 1 : (tintMul & 255) / 255;
    const add = modeOf(flags);
    const slot = slotOf(flags);
    const [ox0, oy0, oz0] = this.ground;
    const savedKey = this.depthKey;
    const d = b.data;
    for (let n = 0; n < b.count; n++) {
      const o = n * BATCH3_STRIDE;
      const gx = d[o] + ox0;
      const gy = d[o + 1] + oy0;
      const gz = d[o + 2] + oz0;
      const [w, h, ox, oy] = [d[o + 3], d[o + 4], d[o + 5], d[o + 6]];
      const [u0, v0, u1, v1] = [d[o + 7], d[o + 8], d[o + 9], d[o + 10]];
      const tint = d[o + 11];
      const alpha = d[o + 12] * alphaMul;
      const bias = d[o + 13];
      const r = (((tint >> 16) & 255) / 255) * mr;
      const g = (((tint >> 8) & 255) / 255) * mg;
      const bl = ((tint & 255) / 255) * mb;
      if (this.proj) {
        const [sx, sy, depth] = this.screenOf(gx, gy, gz);
        const cm = this.proj.cam;
        const scale = Math.max(Math.abs(cm[0]) + Math.abs(cm[2]), Math.abs(cm[1]) + Math.abs(cm[3]));
        const extent = Math.max(w, h) * scale;
        if (this.viewW > 0 && (sx + extent < 0 || sy + extent < 0 || sx - extent > this.viewW || sy - extent > this.viewH)) continue;
        this.depthKey = depth + bias;
        this.push(sx, sy, cm[0], cm[1], cm[2], cm[3], -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, r, g, bl, alpha, add, slot);
      } else {
        const x = gx;
        const y = gy - gz;
        if (!this.visible(x, y, Math.max(w, h))) continue;
        const m = this.m;
        const tx = m[0] * x + m[2] * y + m[4];
        const ty = m[1] * x + m[3] * y + m[5];
        this.push(tx, ty, m[0], m[1], m[2], m[3], -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, r, g, bl, alpha, add, slot);
      }
    }
    this.depthKey = savedKey;
  }

  private emit(a: number, b = 0, c = 0, n = 1, d = 0, e = 0): void {
    const at = this.stats[STAT.COMMANDS];
    if (at + n > this.commands.length) {
      this.stats[STAT.DROPPED]++;
      return;
    }
    this.commands[at] = a;
    if (n > 1) this.commands[at + 1] = b;
    if (n > 2) this.commands[at + 2] = c;
    if (n > 3) this.commands[at + 3] = d;
    if (n > 4) this.commands[at + 4] = e;
    this.stats[STAT.COMMANDS] = at + n;
  }

  private flushDraw(): void {
    if (this.quads > this.drawStart) {
      this.emit(CMD.DRAW, this.drawStart * 4, (this.quads - this.drawStart) * 4, 3);
      this.stats[STAT.DRAWS]++;
    }
    this.drawStart = this.quads;
  }

  /** Write a quad to the vertex buffer, or hold it for the depth sort of a projected pass. */
  private emitQuad(v: Float32Array): void {
    if (this.sorted) {
      if (this.quads + this.pending.length >= this.maxQuads) {
        this.stats[STAT.DROPPED]++;
        return;
      }
      const seq = this.pending.length;
      let quad = this.pendingPool[seq];
      if (!quad) this.pendingPool[seq] = quad = { key: 0, seq, v: new Float32Array(4 * FLOATS_PER_VERT) };
      quad.key = this.depthKey;
      quad.v.set(v);
      this.pending.push(quad);
      this.stats[STAT.SPRITES]++;
      return;
    }
    if (this.quads >= this.maxQuads) {
      this.stats[STAT.DROPPED]++;
      return;
    }
    this.vertices.set(v, this.quads * 4 * FLOATS_PER_VERT);
    this.quads++;
    this.stats[STAT.SPRITES]++;
  }

  /** Sort the held quads by depth key (stable by sequence) and write them out. */
  private flushSorted(): void {
    if (this.pending.length === 0) return;
    const pending = this.pending;
    pending.sort((a, b) => a.key - b.key || a.seq - b.seq);
    for (const q of pending) {
      if (this.quads >= this.maxQuads) {
        this.stats[STAT.DROPPED]++;
        continue;
      }
      this.vertices.set(q.v, this.quads * 4 * FLOATS_PER_VERT);
      this.quads++;
    }
    pending.length = 0;
  }

  private push(
    tx: number, ty: number, ax: number, ay: number, bx: number, by: number,
    x0: number, y0: number, x1: number, y1: number,
    u0: number, v0: number, u1: number, v1: number,
    r: number, g: number, b: number, a: number, mode: number, slot: number, p0 = 0, p1 = 0,
  ): void {
    const S = FLOATS_PER_VERT;
    const V = this.quadScratch;
    V[0] = tx + ax * x0 + bx * y0;
    V[1] = ty + ay * x0 + by * y0;
    V[2] = u0;
    V[3] = v0;
    V[S] = tx + ax * x1 + bx * y0;
    V[S + 1] = ty + ay * x1 + by * y0;
    V[S + 2] = u1;
    V[S + 3] = v0;
    V[2 * S] = tx + ax * x1 + bx * y1;
    V[2 * S + 1] = ty + ay * x1 + by * y1;
    V[2 * S + 2] = u1;
    V[2 * S + 3] = v1;
    V[3 * S] = tx + ax * x0 + bx * y1;
    V[3 * S + 1] = ty + ay * x0 + by * y1;
    V[3 * S + 2] = u0;
    V[3 * S + 3] = v1;
    for (let k = 0; k < 4; k++) {
      const c = k * S;
      V[c + 4] = r;
      V[c + 5] = g;
      V[c + 6] = b;
      V[c + 7] = a;
      V[c + 8] = mode;
      V[c + 9] = slot;
      V[c + 10] = p0;
      V[c + 11] = p1;
    }
    this.emitQuad(V);
  }

  /** Four explicit corners (already in screen space) with one texel, colour and mode. */
  private pushPoints(pts: number[], u: number, v: number, r: number, g: number, b: number, a: number, mode: number, slot: number, p0 = 0, p1 = 0): void {
    const S = FLOATS_PER_VERT;
    const V = this.quadScratch;
    for (let k = 0; k < 4; k++) {
      const c = k * S;
      V[c] = pts[k * 2];
      V[c + 1] = pts[k * 2 + 1];
      V[c + 2] = pts.length > 8 ? pts[8 + k * 2] : u;
      V[c + 3] = pts.length > 8 ? pts[8 + k * 2 + 1] : v;
      V[c + 4] = r;
      V[c + 5] = g;
      V[c + 6] = b;
      V[c + 7] = a;
      V[c + 8] = mode;
      V[c + 9] = slot;
      V[c + 10] = p0;
      V[c + 11] = p1;
    }
    this.emitQuad(V);
  }

  /** A procedural light: a quad of radius `radius` whose texture coordinates run -1..1 from the centre. */
  private light(x: number, y: number, radius: number, color: number, intensity: number, falloff: number, height: number, flags: number): void {
    if (!this.visible(x, y, radius)) return;
    const m = this.m;
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    this.push(tx, ty, m[0] * radius, m[1] * radius, m[2] * radius, m[3] * radius, -1, -1, 1, 1, -1, -1, 1, 1, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, intensity, (flags & 3) || 1, 3, height, falloff);
  }

  /** Four points through the current transform, filled with one colour. */
  private quad(p: number[], color: number, alpha: number, flags: number): void {
    const m = this.m;
    const pts: number[] = [];
    for (let k = 0; k < 4; k++) {
      const x = p[k * 2];
      const y = p[k * 2 + 1];
      pts.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    }
    this.pushPoints(pts, this.whiteU, this.whiteV, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, alpha, modeOf(flags), slotOf(flags));
  }

  /** Textured triangles (x, y, u, v per vertex) through the current transform; each becomes a degenerate quad. */
  private mesh(at: number, n: number, tint: number, alpha: number, flags: number): void {
    const s = this.stream;
    const m = this.m;
    const r = ((tint >> 16) & 255) / 255;
    const g = ((tint >> 8) & 255) / 255;
    const b = (tint & 255) / 255;
    const mode = modeOf(flags);
    const slot = slotOf(flags);
    for (let t = 0; t + 2 < n; t += 3) {
      const pts: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const o = at + (t + k) * 4;
        const x = s[o];
        const y = s[o + 1];
        pts[k * 2] = m[0] * x + m[2] * y + m[4];
        pts[k * 2 + 1] = m[1] * x + m[3] * y + m[5];
        pts[8 + k * 2] = s[o + 2];
        pts[8 + k * 2 + 1] = s[o + 3];
      }
      pts[6] = pts[4];
      pts[7] = pts[5];
      pts[14] = pts[12];
      pts[15] = pts[13];
      this.pushPoints(pts, 0, 0, r, g, b, alpha, mode, slot);
    }
  }

  private sprite(x: number, y: number, sx: number, sy: number, rot: number, ox: number, oy: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, tint: number, alpha: number, flags: number, p0 = 0, p1 = 0): void {
    let cos = 1;
    let sin = 0;
    if (rot !== 0) {
      cos = Math.cos(rot);
      sin = Math.sin(rot);
    }
    const m = this.m;
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    const ax = (m[0] * cos + m[2] * sin) * sx;
    const ay = (m[1] * cos + m[3] * sin) * sx;
    const bx = (-m[0] * sin + m[2] * cos) * sy;
    const by = (-m[1] * sin + m[3] * cos) * sy;
    let x0 = -ox;
    let y0 = -oy;
    let x1 = w - ox;
    let y1 = h - oy;
    if (((flags >> 5) & 15) === 3) {
      // An outline needs one texel of room around the sprite; p0, p1 are the atlas texel size.
      x0 -= 1;
      y0 -= 1;
      x1 += 1;
      y1 += 1;
      u0 -= p0;
      v0 -= p1;
      u1 += p0;
      v1 += p1;
    }
    this.push(tx, ty, ax, ay, bx, by, x0, y0, x1, y1, u0, v0, u1, v1, ((tint >> 16) & 255) / 255, ((tint >> 8) & 255) / 255, (tint & 255) / 255, alpha, modeOf(flags), slotOf(flags), p0, p1);
  }

  private rect(x: number, y: number, w: number, h: number, color: number, alpha: number, flags: number): void {
    const m = this.m;
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    const u = this.whiteU;
    const v = this.whiteV;
    this.push(tx, ty, m[0], m[1], m[2], m[3], 0, 0, w, h, u, v, u, v, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, alpha, modeOf(flags), slotOf(flags));
  }

  private glyph(x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, color: number, alpha: number, flags: number): void {
    const m = this.m;
    const tx = m[0] * x + m[2] * y + m[4];
    const ty = m[1] * x + m[3] * y + m[5];
    this.push(tx, ty, m[0], m[1], m[2], m[3], 0, 0, w, h, u0, v0, u1, v1, ((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, alpha, modeOf(flags), 2, flags >>> 9);
  }

  private visible(x: number, y: number, extent: number): boolean {
    if (this.viewW <= 0) return true;
    const t = this.m;
    const sx = t[0] * x + t[2] * y + t[4];
    const sy = t[1] * x + t[3] * y + t[5];
    const scale = Math.max(Math.abs(t[0]) + Math.abs(t[2]), Math.abs(t[1]) + Math.abs(t[3]));
    const m = extent * scale;
    return sx + m >= 0 && sy + m >= 0 && sx - m <= this.viewW && sy - m <= this.viewH;
  }

  run(streamLength: number): void {
    const s = this.stream;
    const len = Math.min(streamLength, s.length);
    this.stats.fill(0);
    this.quads = 0;
    this.drawStart = 0;
    this.m = [1, 0, 0, 1, 0, 0];
    this.proj = null;
    this.sorted = false;
    this.pending.length = 0;
    this.depthKey = 0;
    this.ground = [0, 0, 0];
    let i = 0;
    loop: while (i < len) {
      if (commandWords(s, i, len) === 0) {
        this.stats[STAT.DROPPED]++;
        break;
      }
      switch (s[i]) {
        case OP.BEGIN:
          this.viewW = s[i + 2];
          this.viewH = s[i + 3];
          this.emit(CMD.BEGIN, s[i + 1] & 0xffffff, 0, 2);
          i += 4;
          break;
        case OP.PASS:
          this.flushSorted();
          this.flushDraw();
          this.emit(CMD.PASS, s[i + 1], s[i + 2] & 0xffffff, 3);
          i += 3;
          break;
        case OP.TRANSFORM:
          this.m = [s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6]];
          i += 7;
          break;
        case OP.SPRITE:
          this.sprite(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8], s[i + 9], s[i + 10], s[i + 11], s[i + 12], s[i + 13], s[i + 14], s[i + 15], s[i + 16], s[i + 17], s[i + 18]);
          i += 19;
          break;
        case OP.LIGHT:
          this.light(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8]);
          i += 9;
          break;
        case OP.QUAD:
          this.quad([s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8]], s[i + 9], s[i + 10], s[i + 11]);
          i += 12;
          break;
        case OP.MESH: {
          const n = s[i + 1];
          this.mesh(i + 5, n, s[i + 2], s[i + 3], s[i + 4]);
          i += 5 + n * 4;
          break;
        }
        case OP.RECT:
          this.rect(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7]);
          i += 8;
          break;
        case OP.GLYPH:
          this.glyph(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8], s[i + 9], s[i + 10], s[i + 11]);
          i += 12;
          break;
        case OP.BATCH:
          this.drawBatch(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8]);
          i += 9;
          break;
        case OP.PARTICLES:
          this.particles(s[i + 1], s[i + 2], s[i + 3] !== 0, s[i + 4], s[i + 5], s[i + 6], s[i + 7] !== 0);
          i += 8;
          break;
        case OP.END:
          this.flushSorted();
          this.flushDraw();
          this.emit(CMD.END, 0, 0, 1);
          i += 1;
          break;
        case OP.CLIP: {
          const [x, y, w, h] = [s[i + 1], s[i + 2], s[i + 3], s[i + 4]];
          const m = this.m;
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          for (const [cx, cy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
            const px = m[0] * cx + m[2] * cy + m[4];
            const py = m[1] * cx + m[3] * cy + m[5];
            x0 = Math.min(x0, px);
            y0 = Math.min(y0, py);
            x1 = Math.max(x1, px);
            y1 = Math.max(y1, py);
          }
          this.flushSorted();
          this.flushDraw();
          this.emit(CMD.SCISSOR, Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)), 5, Math.max(1, Math.ceil(x1) - Math.floor(x0)), Math.max(1, Math.ceil(y1) - Math.floor(y0)));
          i += 5;
          break;
        }
        case OP.CLIP_END:
          this.flushSorted();
          this.flushDraw();
          this.emit(CMD.SCISSOR, 0, 0, 5, 0, 0);
          i += 1;
          break;
        case OP.PROJECTION: {
          const p: number[] = [];
          for (let k = 0; k < 12; k++) p.push(s[i + 1 + k]);
          const cam = [s[i + 13], s[i + 14], s[i + 15], s[i + 16], s[i + 17], s[i + 18]];
          this.flushSorted();
          this.proj = { p, cam };
          this.sorted = s[i + 19] !== 0;
          this.depthKey = 0;
          this.ground = [0, 0, 0];
          this.m = [cam[0], cam[1], cam[2], cam[3], cam[4], cam[5]];
          i += 20;
          break;
        }
        case OP.PROJECTION_END:
          this.flushSorted();
          this.proj = null;
          this.sorted = false;
          this.depthKey = 0;
          i += 1;
          break;
        case OP.TRANSFORM3:
          this.transform3(s[i + 1], s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7], s[i + 8], s[i + 9] !== 0, s[i + 10]);
          i += 11;
          break;
        case OP.BATCH3:
          this.drawBatch3(s[i + 1], s[i + 2], s[i + 3], s[i + 4]);
          i += 5;
          break;
        case OP.NODES:
          this.drawNodes(s[i + 1], s[i + 2], s[i + 3], s[i + 4]);
          i += 5;
          break;
        default:
          break loop;
      }
    }
    this.stats[STAT.VERTICES] = this.quads * 4;
    let batches = 0;
    for (const b of this.batches) if (b) batches++;
    let emitters = 0;
    let live = 0;
    for (const e of this.emitters) {
      if (!e) continue;
      emitters++;
      live += e.live.length;
    }
    this.stats[STAT.BATCHES] = batches;
    this.stats[STAT.EMITTERS] = emitters;
    this.stats[STAT.PARTICLES] = live;
  }

  createBatch(capacity: number): number {
    const cap = Math.max(1, capacity);
    const batch: Batch = { data: new Float32Array(cap * BATCH_STRIDE), count: 0, capacity: cap };
    const slot = this.batches.indexOf(null);
    if (slot >= 0) {
      this.batches[slot] = batch;
      return slot;
    }
    this.batches.push(batch);
    return this.batches.length - 1;
  }

  batchData(id: number): Float32Array {
    return this.batches[id]?.data ?? new Float32Array(0);
  }

  setBatchCount(id: number, count: number): void {
    const b = this.batches[id];
    if (b) b.count = Math.min(count, b.capacity);
  }

  destroyBatch(id: number): void {
    if (id >= 0 && id < this.batches.length) this.batches[id] = null;
  }

  private drawBatch(id: number, alpha: number, tint: number, cx: number, cy: number, cw: number, ch: number, flags: number): void {
    const b = this.batches[id];
    if (!b) return;
    const culling = cw > 0 && ch > 0;
    const m = this.m;
    const r = ((tint >> 16) & 255) / 255;
    const g = ((tint >> 8) & 255) / 255;
    const bl = (tint & 255) / 255;
    const add = modeOf(flags);
    const slot = slotOf(flags);
    const d = b.data;
    for (let n = 0; n < b.count; n++) {
      const o = n * BATCH_STRIDE;
      const x = d[o];
      const y = d[o + 1];
      const w = d[o + 2];
      const h = d[o + 3];
      if (culling && (x + w < cx || x > cx + cw || y + h < cy || y > cy + ch)) continue;
      const tx = m[0] * x + m[2] * y + m[4];
      const ty = m[1] * x + m[3] * y + m[5];
      this.push(tx, ty, m[0], m[1], m[2], m[3], 0, 0, w, h, d[o + 4], d[o + 5], d[o + 6], d[o + 7], r, g, bl, alpha, add, slot);
    }
  }

  createEmitter(words: number): number {
    const c = this.scratch;
    const g = (k: number) => (k < words ? c[k] : 0);
    const colorCount = g(CFG.COLOR_COUNT);
    const colors: number[] = [];
    for (let k = 0; k < colorCount; k++) colors.push(g(CFG.COLORS + k));
    if (colors.length === 0) colors.push(0xffffff);
    const e: Emitter = {
      rate: g(CFG.RATE),
      life: [g(CFG.LIFE0), g(CFG.LIFE1)],
      speed: [g(CFG.SPEED0), g(CFG.SPEED1)],
      angle: [g(CFG.ANGLE0), g(CFG.ANGLE1)],
      gravity: g(CFG.GRAVITY),
      drag: g(CFG.DRAG),
      size: [g(CFG.SIZE0), g(CFG.SIZE1)],
      sizeEnd: g(CFG.SIZE_END),
      alpha: [g(CFG.ALPHA0), g(CFG.ALPHA1)],
      spread: g(CFG.SPREAD),
      spin: g(CFG.SPIN),
      max: Math.max(0, g(CFG.MAX)),
      additive: g(CFG.ADDITIVE) !== 0,
      sprite: g(CFG.HAS_SPRITE) !== 0 ? { w: g(CFG.SPRITE_W), h: g(CFG.SPRITE_H), ox: g(CFG.SPRITE_OX), oy: g(CFG.SPRITE_OY), u0: g(CFG.SPRITE_U0), v0: g(CFG.SPRITE_V0), u1: g(CFG.SPRITE_U1), v1: g(CFG.SPRITE_V1) } : null,
      colors,
      rng: new Rng(g(CFG.SEED) >>> 0),
      acc: 0,
      live: [],
    };
    const slot = this.emitters.indexOf(null);
    if (slot >= 0) {
      this.emitters[slot] = e;
      return slot;
    }
    this.emitters.push(e);
    return this.emitters.length - 1;
  }

  private spawn(e: Emitter, x: number, y: number): void {
    if (e.live.length >= e.max) return;
    const r = e.rng;
    const a = r.range(e.angle[0], e.angle[1]);
    const sp = r.range(e.speed[0], e.speed[1]);
    const off = e.spread > 0 ? r.range(0, e.spread) : 0;
    const oa = r.range(0, TAU);
    const maxLife = r.range(e.life[0], e.life[1]);
    const size = r.range(e.size[0], e.size[1]);
    const color = e.colors[Math.min(e.colors.length - 1, Math.floor(r.next() * e.colors.length))];
    const rot = e.sprite ? r.range(0, TAU) : 0;
    const spin = e.spin * r.sign();
    e.live.push({ x: x + Math.cos(oa) * off, y: y + Math.sin(oa) * off, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: maxLife, maxLife, size, rot, spin, color });
  }

  burst(id: number, n: number, x: number, y: number): void {
    const e = this.emitters[id];
    if (!e) return;
    for (let i = 0; i < n; i++) this.spawn(e, x, y);
  }

  emitterCount(id: number): number {
    return this.emitters[id]?.live.length ?? 0;
  }

  clearEmitter(id: number): void {
    const e = this.emitters[id];
    if (e) e.live.length = 0;
  }

  destroyEmitter(id: number): void {
    if (id >= 0 && id < this.emitters.length) this.emitters[id] = null;
  }

  private particles(id: number, dt: number, emitting: boolean, ex: number, ey: number, alphaMul: number, snap: boolean): void {
    const e = this.emitters[id];
    if (!e) return;
    if (emitting && e.rate > 0) {
      e.acc += e.rate * dt;
      const n = Math.floor(e.acc);
      if (n > 0) {
        e.acc -= n;
        for (let i = 0; i < n; i++) this.spawn(e, ex, ey);
      }
    }
    const dragK = e.drag > 0 ? Math.max(0, 1 - e.drag * dt) : 1;
    let write = 0;
    for (let i = 0; i < e.live.length; i++) {
      const p = e.live[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy += e.gravity * dt;
      p.vx *= dragK;
      p.vy *= dragK;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      e.live[write++] = p;
    }
    e.live.length = write;
    const m = this.m;
    const add = e.additive ? 1 : 0;
    for (const p of e.live) {
      const t = 1 - p.life / p.maxLife;
      const alpha = (e.alpha[0] + (e.alpha[1] - e.alpha[0]) * t) * alphaMul;
      const size = p.size * (1 + (e.sizeEnd - 1) * t);
      const sp = e.sprite;
      if (sp) {
        let x = p.x;
        let y = p.y;
        if (snap) {
          x = jsRound(x);
          y = jsRound(y);
        }
        const extent = Math.max(sp.w * Math.abs(size), sp.h * Math.abs(size));
        if (!this.visible(x, y, extent)) continue;
        let cos = 1;
        let sin = 0;
        if (p.rot !== 0) {
          cos = Math.cos(p.rot);
          sin = Math.sin(p.rot);
        }
        const tx = m[0] * x + m[2] * y + m[4];
        const ty = m[1] * x + m[3] * y + m[5];
        const ax = (m[0] * cos + m[2] * sin) * size;
        const ay = (m[1] * cos + m[3] * sin) * size;
        const bx = (-m[0] * sin + m[2] * cos) * size;
        const by = (-m[1] * sin + m[3] * cos) * size;
        this.push(tx, ty, ax, ay, bx, by, -sp.ox, -sp.oy, sp.w - sp.ox, sp.h - sp.oy, sp.u0, sp.v0, sp.u1, sp.v1, ((p.color >> 16) & 255) / 255, ((p.color >> 8) & 255) / 255, (p.color & 255) / 255, alpha, add, 0);
      } else {
        const s = Math.max(1, jsRound(size));
        const x = jsRound(p.x - s / 2);
        const y = jsRound(p.y - s / 2);
        if (!this.visible(x + s / 2, y + s / 2, s)) continue;
        this.rect(x, y, s, s, p.color, alpha, add);
      }
    }
  }

  // --- Node tables ---------------------------------------------------------------------

  createNodes(capacity: number): number {
    const t = new NodeTable(capacity);
    const slot = this.tables.indexOf(null);
    if (slot >= 0) {
      this.tables[slot] = t;
      return slot;
    }
    this.tables.push(t);
    return this.tables.length - 1;
  }

  nodesData(id: number): Float32Array {
    return this.tables[id]?.data ?? new Float32Array(0);
  }

  allocNode(id: number): number {
    return this.tables[id]?.alloc() ?? -1;
  }

  freeNode(id: number, index: number): void {
    this.tables[id]?.freeNode(index);
  }

  clearNodes(id: number): void {
    this.tables[id]?.clear();
  }

  nodeCount(id: number): number {
    return this.tables[id]?.live ?? 0;
  }

  nodesHigh(id: number): number {
    return this.tables[id]?.high ?? 0;
  }

  stepNodes(id: number, dt: number): void {
    this.tables[id]?.step(dt);
  }

  configureNodes(id: number, gx: number, gy: number, damping: number, boundsMode: number, bx: number, by: number, bw: number, bh: number, gz = 0, floor = 0): void {
    const t = this.tables[id];
    if (!t) return;
    t.gravity = [gx, gy];
    t.damping = damping;
    t.boundsMode = boundsMode;
    t.bounds = [bx, by, bw, bh];
    t.gravityZ = gz;
    t.floor = floor;
  }

  setNodeFrames(id: number, words: number): void {
    const t = this.tables[id];
    if (!t) return;
    const s = this.scratch;
    t.frames = [];
    for (let o = 0; o + FRAME_WORDS <= Math.min(words, s.length); o += FRAME_WORDS) {
      t.frames.push({ w: s[o], h: s[o + 1], ox: s[o + 2], oy: s[o + 3], u0: s[o + 4], v0: s[o + 5], u1: s[o + 6], v1: s[o + 7] });
    }
  }

  applyNodeTransforms(id: number, words: number): number {
    const t = this.tables[id];
    if (!t) return 0;
    return t.applyTransforms(this.scratch.subarray(0, Math.min(words, this.scratch.length)));
  }

  destroyNodes(id: number): void {
    if (id >= 0 && id < this.tables.length) this.tables[id] = null;
  }

  private drawNodes(id: number, alphaMul: number, tintMul: number, opFlags: number): void {
    const t = this.tables[id];
    if (!t) return;
    const savedKey = this.depthKey;
    const mr = tintMul === 0xffffff ? 1 : ((tintMul >> 16) & 255) / 255;
    const mg = tintMul === 0xffffff ? 1 : ((tintMul >> 8) & 255) / 255;
    const mb = tintMul === 0xffffff ? 1 : (tintMul & 255) / 255;
    const d = t.data;
    const m = this.m;
    for (let i = 0; i < t.high; i++) {
      const o = i * NODE_WORDS;
      const flags = d[o + N.FLAGS];
      if ((flags & F.ALIVE) === 0 || flags & F.HIDDEN) continue;
      let w: number;
      let h: number;
      let ox: number;
      let oy: number;
      let u0: number;
      let v0: number;
      let u1: number;
      let v1: number;
      if (t.frames.length > 0 && d[o + N.FRAME_COUNT] > 0) {
        const idx = d[o + N.FRAME_BASE] + Math.min(Math.max(0, Math.floor(d[o + N.FRAME])), d[o + N.FRAME_COUNT] - 1);
        const fr = t.frames[idx] ?? { w: 0, h: 0, ox: 0, oy: 0, u0: 0, v0: 0, u1: 0, v1: 0 };
        [w, h, ox, oy, u0, v0, u1, v1] = [fr.w, fr.h, fr.ox, fr.oy, fr.u0, fr.v0, fr.u1, fr.v1];
      } else {
        [w, h, ox, oy, u0, v0, u1, v1] = [d[o + N.W], d[o + N.H], d[o + N.OX], d[o + N.OY], d[o + N.U0], d[o + N.V0], d[o + N.U1], d[o + N.V1]];
      }
      let sx = d[o + N.SX];
      let sy = d[o + N.SY];
      if (flags & F.FLIP_X) sx = -sx;
      if (flags & F.FLIP_Y) sy = -sy;
      const x = d[o + N.X];
      const y = d[o + N.Y];
      const tint = d[o + N.TINT];
      const alpha = d[o + N.ALPHA] * alphaMul;
      const add = flags & F.ADDITIVE ? 1 : opFlags & 3;
      const smooth = flags & F.SMOOTH ? 1 : slotOf(opFlags);
      const rot = d[o + N.ROT];
      let cos = 1;
      let sin = 0;
      if (rot !== 0) {
        cos = Math.cos(rot);
        sin = Math.sin(rot);
      }
      let mm = m;
      let tx: number;
      let ty: number;
      if (this.proj) {
        // Under a projection nodes are in the table node's ground space.
        const gx = x + this.ground[0];
        const gy = y + this.ground[1];
        const gz = d[o + N.Z] + this.ground[2];
        const [px, py, depth] = this.screenOf(gx, gy, gz);
        const cm = this.proj.cam;
        const scale = Math.max(Math.abs(cm[0]) + Math.abs(cm[2]), Math.abs(cm[1]) + Math.abs(cm[3]));
        const extent = Math.max(w * Math.abs(sx), h * Math.abs(sy)) * scale;
        if (this.viewW > 0 && (px + extent < 0 || py + extent < 0 || px - extent > this.viewW || py - extent > this.viewH)) continue;
        this.depthKey = depth + d[o + N.DEPTH_BIAS];
        if (flags & F.SHADOW) this.shadowAt(gx, gy, gz, 0.5, d[o + N.DEPTH_BIAS]);
        mm = [cm[0], cm[1], cm[2], cm[3], 0, 0];
        tx = px;
        ty = py;
      } else {
        const extent = Math.max(w * Math.abs(sx), h * Math.abs(sy));
        if (!this.visible(x, y, extent)) continue;
        tx = m[0] * x + m[2] * y + m[4];
        ty = m[1] * x + m[3] * y + m[5];
      }
      const ax = (mm[0] * cos + mm[2] * sin) * sx;
      const ay = (mm[1] * cos + mm[3] * sin) * sx;
      const bx = (-mm[0] * sin + mm[2] * cos) * sy;
      const by = (-mm[1] * sin + mm[3] * cos) * sy;
      this.push(tx, ty, ax, ay, bx, by, -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, (((tint >> 16) & 255) / 255) * mr, (((tint >> 8) & 255) / 255) * mg, ((tint & 255) / 255) * mb, alpha, add, smooth);
    }
    this.depthKey = savedKey;
  }

  destroy(): void {
    this.batches.length = 0;
    this.emitters.length = 0;
    this.tables.length = 0;
    this.batches3.length = 0;
  }
}
