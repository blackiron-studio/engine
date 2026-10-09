// Axial hex coordinates (q, r), pointy-top orientation. Enough for hex battle grids.

export interface Hex {
  q: number;
  r: number;
}

export const hexEquals = (a: Hex, b: Hex): boolean => a.q === b.q && a.r === b.r;

export const hexDistance = (a: Hex, b: Hex): number => {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};

const DIRS: ReadonlyArray<Hex> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const hexNeighbors = (h: Hex): Hex[] => DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));

export function hexRound(q: number, r: number): Hex {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Pixel centre of a hex with the given circumradius. */
export function hexToPixel(h: Hex, size: number): { x: number; y: number } {
  return {
    x: size * (Math.sqrt(3) * h.q + (Math.sqrt(3) / 2) * h.r),
    y: size * 1.5 * h.r,
  };
}

export function pixelToHex(x: number, y: number, size: number): Hex {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * y) / size;
  const r = ((2 / 3) * y) / size;
  return hexRound(q, r);
}

/** All hexes within `radius` of the centre, centre included. */
export function hexRange(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
      out.push({ q: center.q + q, r: center.r + r });
    }
  }
  return out;
}

/** Hexes along a straight line, inclusive. */
export function hexLine(a: Hex, b: Hex): Hex[] {
  const n = hexDistance(a, b);
  const out: Hex[] = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    out.push(hexRound(a.q + (b.q - a.q) * t + 1e-6, a.r + (b.r - a.r) * t + 1e-6));
  }
  return out;
}
