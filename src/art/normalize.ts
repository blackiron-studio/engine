// Turning a generated or scanned sprite sheet into game pixels. Generators hand back poses
// on a white ground, upscaled with soft edges, at whatever positions they liked. This keys
// the ground out, finds each pose, works out the real pixel size and resamples to it, snaps
// to the palette, trims, and stands every frame on a common baseline in one sheet with an
// Aseprite-style JSON the engine already imports.

import type { Rect } from "../core/math.ts";
import { type ColorInput, parseColor } from "./color.ts";
import { Painter } from "./painter.ts";
import { snapPalette } from "./style.ts";

export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}


export interface NormalizeOptions {
  /** Background to remove: "auto" samples the corners, a colour keys that colour, null keeps alpha as is. */
  key?: "auto" | ColorInput | null;
  /** How far from the key colour still counts as background, 0 to 255. */
  keyTolerance?: number;
  /** Slice a regular grid instead of finding poses. */
  cell?: { w: number; h: number } | null;
  /** Source pixels per game pixel; "auto" measures it. */
  pixel?: number | "auto";
  /** Snap frames to these colours. */
  palette?: ColorInput[] | null;
  /** How frames share their canvas: "feet" stands them on the bottom, "center" centres them. */
  anchor?: "feet" | "center";
  /** Ignore blobs smaller than this many source pixels. */
  minBlob?: number;
  /** Merge blobs whose boxes come within this many source pixels (a sword tip, a spark). */
  merge?: number;
  /** Transparent margin around each frame in game pixels. */
  pad?: number;
  /** Alpha below this is background when finding poses and edges; generated art has faint halos. */
  alphaMin?: number;
  /**
   * How the pixel grid is found: "adaptive" reads the actual colour edges of each pose, so
   * generated art whose pixels wobble between four and six source pixels still comes out
   * square; "fixed" assumes one pitch and searches its phase.
   */
  grid?: "adaptive" | "fixed";
  /**
   * Shrink the finished frames by a whole factor (2 halves them), averaging blocks and
   * snapping again, so a character drawn at sixty pixels can join a cast drawn at thirty.
   */
  shrink?: number;
}

export interface NormalizedFrame {
  index: number;
  /** Where the pose sat in the source. */
  source: Rect;
  /** Trimmed frame pixels. */
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export interface AsepriteJson {
  frames: { filename: string; frame: Rect; duration: number }[];
  meta: { image: string; size: { w: number; h: number }; frameTags: { name: string; from: number; to: number; direction: string }[] };
}

export interface NormalizeResult {
  pixel: number;
  key: string | null;
  frames: NormalizedFrame[];
  /** Every frame on a common canvas, side by side. */
  sheet: RawImage;
  cell: { w: number; h: number };
  json: AsepriteJson;
}

const rgbDist = (r: number, g: number, b: number, c: { r: number; g: number; b: number }) => Math.sqrt(((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2) / 3);

/** The colour the corners agree on, or null when they disagree (a real transparent image). */
export function cornerKey(img: RawImage): string | null {
  const d = img.data;
  const at = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    return { r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] };
  };
  const corners = [at(0, 0), at(img.width - 1, 0), at(0, img.height - 1), at(img.width - 1, img.height - 1)];
  if (corners.every((c) => c.a === 0)) return null;
  const c0 = corners[0];
  for (const c of corners) if (rgbDist(c.r, c.g, c.b, c0) > 24) return null;
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(c0.r)}${hex(c0.g)}${hex(c0.b)}`;
}

/** Make the key colour transparent, softening the edge where anti-aliasing blended into it. */
export function keyBackground(img: RawImage, key: ColorInput, tolerance = 40): void {
  const k = parseColor(key);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dist = rgbDist(d[i], d[i + 1], d[i + 2], k);
    if (dist <= tolerance) d[i + 3] = 0;
    else if (dist <= tolerance * 2.5) {
      // Partway from the key: keep the colour but lower the alpha so the edge does not halo.
      const a = (dist - tolerance) / (tolerance * 1.5);
      d[i + 3] = Math.min(d[i + 3], Math.round(a * 255));
    }
  }
}

/**
 * The upscale factor of soft pixel art: the most common run length of same-colour pixels
 * along rows and columns, measured inside the opaque area.
 */
export function detectPixelSize(img: RawImage, maxSize = 24, regions: Rect[] | null = null): number {
  // Preferred: the median spacing of colour edges inside the drawing, which survives wobble.
  const rects = regions && regions.length ? regions : [{ x: 0, y: 0, w: img.width, h: img.height }];
  const gaps: number[] = [];
  for (const r of rects) {
    for (const axis of ["x", "y"] as const) {
      const peaks = profilePeaks(edgeProfile(img, r, axis), 2);
      for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
    }
  }
  if (gaps.length >= 12) {
    const m = median(gaps.filter((g) => g <= maxSize));
    if (m >= 1) return m;
  }
  return detectPixelSizeByRuns(img, maxSize);
}

/** The most common run length of same-colour pixels; the fallback when edges are too few. */
export function detectPixelSizeByRuns(img: RawImage, maxSize = 24): number {
  const d = img.data;
  const counts = new Uint32Array(maxSize + 1);
  const same = (i: number, j: number) => d[i + 3] >= 128 && d[j + 3] >= 128 && Math.abs(d[i] - d[j]) < 18 && Math.abs(d[i + 1] - d[j + 1]) < 18 && Math.abs(d[i + 2] - d[j + 2]) < 18;
  for (let y = 0; y < img.height; y++) {
    let run = 1;
    for (let x = 1; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (same(i, i - 4)) run++;
      else {
        if (d[i - 4 + 3] >= 128 && run <= maxSize) counts[run]++;
        run = 1;
      }
    }
  }
  for (let x = 0; x < img.width; x++) {
    let run = 1;
    for (let y = 1; y < img.height; y++) {
      const i = (y * img.width + x) * 4;
      const j = i - img.width * 4;
      if (same(i, j)) run++;
      else {
        if (d[j + 3] >= 128 && run <= maxSize) counts[run]++;
        run = 1;
      }
    }
  }
  // Runs of one are anti-aliasing noise; among the rest, take the mode, then check whether
  // half of it is a stronger fit (the mode is often a double run).
  let best = 1;
  let bestCount = 0;
  for (let n = 2; n <= maxSize; n++) {
    if (counts[n] > bestCount) {
      bestCount = counts[n];
      best = n;
    }
  }
  if (best % 2 === 0 && counts[best / 2] > bestCount * 0.6) best /= 2;
  return Math.max(1, best);
}

/**
 * How much colour changes across each column (axis "x") or row (axis "y") inside a region,
 * counting only pixels opaque enough to be part of the drawing. Pixel boundaries show up
 * as peaks; the spacing between peaks is the pixel pitch, even when it wobbles.
 */
export function edgeProfile(img: RawImage, rect: Rect, axis: "x" | "y", alphaMin = 128): Float64Array {
  const d = img.data;
  const n = axis === "x" ? rect.w : rect.h;
  const out = new Float64Array(n);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      const j = axis === "x" ? i - 4 : i - img.width * 4;
      const inside = axis === "x" ? x > rect.x : y > rect.y;
      if (!inside || d[i + 3] < alphaMin || d[j + 3] < alphaMin) continue;
      const diff = Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
      out[axis === "x" ? x - rect.x : y - rect.y] += diff;
    }
  }
  return out;
}

/** Local maxima of a profile above 1.5 times its mean, at least `minGap` apart (the higher wins). */
export function profilePeaks(profile: Float64Array, minGap = 2): number[] {
  let mean = 0;
  let count = 0;
  for (const v of profile) if (v > 0) {
    mean += v;
    count++;
  }
  if (!count) return [];
  mean /= count;
  const threshold = mean * 1.5;
  const peaks: number[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i] < threshold || profile[i] < profile[i - 1] || profile[i] < profile[i + 1]) continue;
    const last = peaks[peaks.length - 1];
    if (last !== undefined && i - last < minGap) {
      if (profile[i] > profile[last]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  return peaks;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Bounding boxes of the opaque blobs, merged when they come near, in reading order. */
export function findBlobs(img: RawImage, minBlob = 64, merge = 6, alphaMin = 48): Rect[] {
  const { width: w, height: h, data: d } = img;
  const seen = new Uint8Array(w * h);
  const boxes: (Rect & { n: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || d[start * 4 + 3] < alphaMin) continue;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    let n = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p - x) / w;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const tryPush = (q: number) => {
        if (!seen[q] && d[q * 4 + 3] >= alphaMin) {
          seen[q] = 1;
          stack.push(q);
        }
      };
      if (x > 0) tryPush(p - 1);
      if (x < w - 1) tryPush(p + 1);
      if (y > 0) tryPush(p - w);
      if (y < h - 1) tryPush(p + w);
      // Diagonals too: pixel art joins limbs corner to corner.
      if (x > 0 && y > 0) tryPush(p - w - 1);
      if (x < w - 1 && y > 0) tryPush(p - w + 1);
      if (x > 0 && y < h - 1) tryPush(p + w - 1);
      if (x < w - 1 && y < h - 1) tryPush(p + w + 1);
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, n });
  }
  // Poses are the big blobs. Small ones near a pose (a sword tip, a spark, a shadow) join it;
  // two poses never merge with each other, however close, so a tight sheet still slices.
  // A pose is anything at least a fifth the size of the largest blob; the rest are bits.
  let largest = 0;
  for (const b of boxes) if (b.n > largest) largest = b.n;
  const big = largest * 0.2;
  const poses = boxes.filter((b) => b.n >= big && b.n >= minBlob);
  const bits = boxes.filter((b) => !(b.n >= big && b.n >= minBlob));
  const gap = (a: Rect, b: Rect) => {
    const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    return Math.hypot(dx, dy);
  };
  for (const bit of bits) {
    let best: (Rect & { n: number }) | null = null;
    let bestGap = merge + 1;
    for (const pose of poses) {
      const g = gap(bit, pose);
      if (g < bestGap) {
        bestGap = g;
        best = pose;
      }
    }
    if (!best) continue;
    const x = Math.min(best.x, bit.x);
    const y = Math.min(best.y, bit.y);
    best.w = Math.max(best.x + best.w, bit.x + bit.w) - x;
    best.h = Math.max(best.y + best.h, bit.y + bit.h) - y;
    best.x = x;
    best.y = y;
    best.n += bit.n;
  }
  const kept = poses;
  // Reading order: rows first, by the centre of each box, then left to right.
  const rowHeight = kept.length ? kept.reduce((s, b) => s + b.h, 0) / kept.length : 1;
  kept.sort((a, b) => {
    const ra = Math.round((a.y + a.h / 2) / rowHeight);
    const rb = Math.round((b.y + b.h / 2) / rowHeight);
    return ra !== rb ? ra - rb : a.x - b.x;
  });
  return kept.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** Regular cells across the image. */
export function gridCells(img: RawImage, cellW: number, cellH: number): Rect[] {
  const out: Rect[] = [];
  for (let y = 0; y + cellH <= img.height; y += cellH) for (let x = 0; x + cellW <= img.width; x += cellW) out.push({ x, y, w: cellW, h: cellH });
  return out;
}

/**
 * Cell boundaries along one axis from the colour edges in a region: peaks become boundaries,
 * long gaps are split into whole pixels, tiny gaps are absorbed. Returns positions relative
 * to the region, starting at 0 and ending at its length.
 */
export function adaptiveEdges(img: RawImage, rect: Rect, axis: "x" | "y", pixel: number, alphaMin = 128): number[] {
  const length = axis === "x" ? rect.w : rect.h;
  const peaks = profilePeaks(edgeProfile(img, rect, axis, alphaMin), Math.max(2, Math.floor(pixel * 0.5)));
  const edges: number[] = [0];
  for (const p of peaks) if (p > 0 && p < length) edges.push(p);
  edges.push(length);
  // Absorb gaps that are too small to be a pixel, split gaps that hide several.
  const out: number[] = [edges[0]];
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i] - out[out.length - 1];
    if (gap < pixel * 0.55 && i < edges.length - 1) continue;
    const parts = Math.max(1, Math.round(gap / pixel));
    for (let k = 1; k <= parts; k++) out.push(Math.round(out[out.length - 1 - (k - 1)] + (gap * k) / parts));
  }
  out[out.length - 1] = length;
  return out;
}

/** Sample a region on the cells the edges describe; the middle of each cell is the pixel. */
export function downsampleAdaptive(img: RawImage, rect: Rect, pixel: number, alphaMin = 128): RawImage {
  const xs = adaptiveEdges(img, rect, "x", pixel, alphaMin);
  const ys = adaptiveEdges(img, rect, "y", pixel, alphaMin);
  const w = xs.length - 1;
  const h = ys.length - 1;
  const out = new Uint8ClampedArray(w * h * 4);
  const d = img.data;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      const cx = rect.x + Math.floor((xs[gx] + xs[gx + 1]) / 2);
      const cy = rect.y + Math.floor((ys[gy] + ys[gy + 1]) / 2);
      const x = Math.min(img.width - 1, Math.max(0, cx));
      const y = Math.min(img.height - 1, Math.max(0, cy));
      const i = (y * img.width + x) * 4;
      const o = (gy * w + gx) * 4;
      out[o] = d[i];
      out[o + 1] = d[i + 1];
      out[o + 2] = d[i + 2];
      out[o + 3] = d[i + 3] >= alphaMin ? 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Resample a region to game pixels on a fixed pitch. The phase (where the pixel grid starts
 * inside the region) is chosen so each sampled block is as uniform as possible.
 */
export function downsample(img: RawImage, rect: Rect, pixel: number): RawImage {
  if (pixel <= 1) return { width: rect.w, height: rect.h, data: cropRect(img, rect) };
  const w = Math.max(1, Math.round(rect.w / pixel));
  const h = Math.max(1, Math.round(rect.h / pixel));
  const d = img.data;
  const sample = (px: number, py: number, out: number[], o: number) => {
    const x = Math.min(img.width - 1, Math.max(0, px));
    const y = Math.min(img.height - 1, Math.max(0, py));
    const i = (y * img.width + x) * 4;
    out[o] = d[i];
    out[o + 1] = d[i + 1];
    out[o + 2] = d[i + 2];
    out[o + 3] = d[i + 3];
  };
  // Score a phase by how much the centre and the block's corners disagree.
  const scorePhase = (ox: number, oy: number) => {
    let score = 0;
    const c: number[] = [0, 0, 0, 0];
    const k: number[] = [0, 0, 0, 0];
    const half = Math.floor(pixel / 2);
    for (let gy = 0; gy < h; gy += Math.max(1, Math.floor(h / 24))) {
      for (let gx = 0; gx < w; gx += Math.max(1, Math.floor(w / 24))) {
        const bx = rect.x + ox + gx * pixel;
        const by = rect.y + oy + gy * pixel;
        sample(bx + half, by + half, c, 0);
        for (const [dx, dy] of [[1, 1], [pixel - 2, 1], [1, pixel - 2], [pixel - 2, pixel - 2]]) {
          sample(bx + dx, by + dy, k, 0);
          score += Math.abs(c[0] - k[0]) + Math.abs(c[1] - k[1]) + Math.abs(c[2] - k[2]) + Math.abs(c[3] - k[3]);
        }
      }
    }
    return score;
  };
  let bestOx = 0;
  let bestOy = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let oy = -Math.floor(pixel / 2); oy <= Math.floor(pixel / 2); oy++) {
    for (let ox = -Math.floor(pixel / 2); ox <= Math.floor(pixel / 2); ox++) {
      const s = scorePhase(ox, oy);
      if (s < best) {
        best = s;
        bestOx = ox;
        bestOy = oy;
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const tmp: number[] = [0, 0, 0, 0];
  const half = Math.floor(pixel / 2);
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      sample(rect.x + bestOx + gx * pixel + half, rect.y + bestOy + gy * pixel + half, tmp, 0);
      const o = (gy * w + gx) * 4;
      // Edge pixels that came out faint are either in or out.
      out[o] = tmp[0];
      out[o + 1] = tmp[1];
      out[o + 2] = tmp[2];
      out[o + 3] = tmp[3] >= 128 ? 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

function cropRect(img: RawImage, r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4;
    out.set(img.data.subarray(src, src + r.w * 4), y * r.w * 4);
  }
  return out;
}

/** Shrink by a whole factor: each block of n by n becomes one pixel by alpha-weighted average. */
export function shrinkImage(img: RawImage, n: number): RawImage {
  if (n <= 1) return img;
  const w = Math.ceil(img.width / n);
  const h = Math.ceil(img.height / n);
  const out = new Uint8ClampedArray(w * h * 4);
  const d = img.data;
  for (let gy = 0; gy < h; gy++) {
    for (let gx = 0; gx < w; gx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cells = 0;
      for (let y = gy * n; y < Math.min(img.height, gy * n + n); y++) {
        for (let x = gx * n; x < Math.min(img.width, gx * n + n); x++) {
          const i = (y * img.width + x) * 4;
          const alpha = d[i + 3];
          r += d[i] * alpha;
          g += d[i + 1] * alpha;
          b += d[i + 2] * alpha;
          a += alpha;
          cells++;
        }
      }
      const o = (gy * w + gx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        // Half the block or more must be drawn for the pixel to exist.
        out[o + 3] = a / cells >= 128 ? 255 : 0;
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** The opaque bounds of an image, or null when it is empty. */
export function trimBounds(img: RawImage): Rect | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** The whole pipeline. The source image is keyed in place. */
export function normalizeSheet(src: RawImage, opts: NormalizeOptions = {}): NormalizeResult {
  const img: RawImage = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  const keyOpt = opts.key ?? "auto";
  const key = keyOpt === "auto" ? cornerKey(img) : keyOpt === null ? null : String(keyOpt);
  if (key) keyBackground(img, key, opts.keyTolerance ?? 40);
  const alphaMin = opts.alphaMin ?? 48;
  const regions = opts.cell ? gridCells(img, opts.cell.w, opts.cell.h) : findBlobs(img, opts.minBlob ?? 64, opts.merge ?? 6, alphaMin);
  const pixel = opts.pixel === undefined || opts.pixel === "auto" ? detectPixelSize(img, 24, regions) : opts.pixel;
  const pad = opts.pad ?? 1;
  const grid = opts.grid ?? "adaptive";
  const frames: NormalizedFrame[] = [];
  for (const r of regions) {
    let small = grid === "adaptive" && pixel > 1 ? downsampleAdaptive(img, r, pixel, Math.max(alphaMin, 128)) : downsample(img, r, pixel);
    if ((opts.shrink ?? 1) > 1) small = shrinkImage(small, Math.round(opts.shrink ?? 1));
    if (opts.palette?.length) snapPalette(new Painter(small.width, small.height, small.data), opts.palette, 40);
    const bounds = trimBounds(small);
    if (!bounds) continue;
    frames.push({ index: frames.length, source: r, w: bounds.w, h: bounds.h, data: cropRect(small, bounds) });
  }
  // One canvas for all: the widest and tallest frame plus the padding.
  let cw = 1;
  let ch = 1;
  for (const f of frames) {
    cw = Math.max(cw, f.w + pad * 2);
    ch = Math.max(ch, f.h + pad * 2);
  }
  const cols = Math.max(1, Math.min(frames.length, Math.ceil(Math.sqrt(frames.length) * 1.5)));
  const rows = Math.max(1, Math.ceil(frames.length / cols));
  const sheet: RawImage = { width: cols * cw, height: rows * ch, data: new Uint8ClampedArray(cols * cw * rows * ch * 4) };
  const json: AsepriteJson = { frames: [], meta: { image: "", size: { w: sheet.width, h: sheet.height }, frameTags: [] } };
  frames.forEach((f, i) => {
    const cx = (i % cols) * cw;
    const cy = Math.floor(i / cols) * ch;
    const ox = Math.floor((cw - f.w) / 2);
    const oy = (opts.anchor ?? "feet") === "feet" ? ch - pad - f.h : Math.floor((ch - f.h) / 2);
    for (let y = 0; y < f.h; y++) {
      const dst = ((cy + oy + y) * sheet.width + cx + ox) * 4;
      sheet.data.set(f.data.subarray(y * f.w * 4, (y + 1) * f.w * 4), dst);
    }
    json.frames.push({ filename: String(i), frame: { x: cx, y: cy, w: cw, h: ch }, duration: 100 });
  });
  return { pixel, key, frames, sheet, cell: { w: cw, h: ch }, json };
}

/** Add an animation tag over frame indices; contiguous runs only, as the format demands. */
export function tagFrames(json: AsepriteJson, name: string, indices: number[], fps = 8, loop = true): boolean {
  if (indices.length === 0) return false;
  const sorted = [...indices].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
  for (const i of sorted) if (json.frames[i]) json.frames[i].duration = Math.round(1000 / fps);
  json.meta.frameTags.push({ name, from: sorted[0], to: sorted[sorted.length - 1], direction: loop ? "forward" : "once" });
  return true;
}
