import type { Rect } from "@kiln/engine/core";
import { ArcadeWorld2D, ArcadeVehicle2D } from "@kiln/engine/physics";
export const SIZE = { w: 2540, h: 2200 };
export const XS = [260, 740, 1220, 1700, 2180],
  YS = [260, 740, 1220, 1700];
export const START = { x: 664, y: 1300 };
export const PICKUP = { x: 1272, y: 684 },
  DROP = { x: 2250, y: 1700 };
export interface Building extends Rect {
  color: number;
  trim: number;
  label: string;
  kind: number;
}
export const buildings: Building[] = [];
const colors = [0x765e66, 0x8c776f, 0x526778, 0x6c7970, 0x7a6669, 0x506578];
for (let j = 0; j < YS.length - 1; j++)
  for (let i = 0; i < XS.length - 1; i++) {
    if (i === 1 && j === 1) continue; // civic park
    const x = XS[i] + 92,
      y = YS[j] + 92;
    const labels = [
      "NORTHSTAR",
      "STUDIO 04",
      "LOWLINE FM",
      "GRAND HOTEL",
      "COLD STORAGE",
      "MOTOR CLUB",
      "NIGHT MARKET",
      "RECORDS",
    ];
    buildings.push({
      x,
      y,
      w: 190,
      h: 280,
      color: colors[(i + j * 2) % 6],
      trim: 0xddb697,
      label: i === 2 && j === 0 ? "NORTHSTAR RECORDS" : labels[(i + j * 3) % 8],
      kind: (i + j) % 3,
    });
    buildings.push({
      x: x + 214,
      y: y + 36,
      w: 90,
      h: 244,
      color: colors[(i + j + 3) % 6],
      trim: 0x87ada9,
      label: "",
      kind: 2,
    });
  }
export const world = new ArcadeWorld2D(
  { x: 135, y: 135, w: 2210, h: 1880 },
  buildings,
);
export const distance = (
  a: { x: number; y: number },
  b: { x: number; y: number },
) => Math.hypot(a.x - b.x, a.y - b.y);
export const angleDelta = (a: number, b: number) =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));
export interface Car {
  motor: ArcadeVehicle2D;
  color: number;
  kind: "parked" | "traffic" | "police";
  route: { x: number; y: number }[];
  waypoint: number;
  health: number;
  cooldown: number;
}
export function makeCar(
  x: number,
  y: number,
  angle: number,
  color: number,
  kind: Car["kind"] = "parked",
): Car {
  return {
    motor: new ArcadeVehicle2D(
      x,
      y,
      angle,
      kind === "police" ? { topSpeed: 255, acceleration: 185 } : {},
    ),
    color,
    kind,
    route: [],
    waypoint: 0,
    health: 100,
    cooldown: 0,
  };
}
export function makeTraffic(): Car[] {
  const cars = [
    makeCar(777, 1260, 0, 0xefb561),
    makeCar(1660, 795, Math.PI / 2, 0xd48479),
    makeCar(2120, 1640, 0, 0x7db5bb),
  ];
  for (let i = 0; i < 12; i++) {
    const col = i % 4,
      row = Math.floor(i / 4),
      x = XS[col],
      y = YS[row],
      offset = 24;
    const route = [
      { x: x + offset, y: y + offset },
      { x: XS[col + 1] - offset, y: y + offset },
      { x: XS[col + 1] - offset, y: YS[row + 1] - offset },
      { x: x + offset, y: YS[row + 1] - offset },
    ];
    const waypoint = i % 4,
      p = route[waypoint],
      next = route[(waypoint + 1) % 4];
    const c = makeCar(
      p.x,
      p.y,
      Math.atan2(next.y - p.y, next.x - p.x),
      [0x779ca4, 0xd39a73, 0xb1baab, 0x9b809d][i % 4],
      "traffic",
    );
    c.route = route;
    c.waypoint = (waypoint + 1) % 4;
    cars.push(c);
  }
  return cars;
}
/** Road intersection routing; a authored orthogonal grid, not general urban navigation. */
export function roadRoute(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] {
  const near = (v: number, list: number[]) =>
    list.reduce((a, b) => (Math.abs(a - v) < Math.abs(b - v) ? a : b));
  const x = near(from.x, XS),
    y = near(from.y, YS),
    tx = near(to.x, XS),
    ty = near(to.y, YS);
  const result: { x: number; y: number }[] = [];
  if (Math.abs(from.x - x) < Math.abs(from.y - y))
    result.push({ x: from.x, y });
  else result.push({ x, y: from.y });
  result.push({ x, y });
  let ix = XS.indexOf(x),
    iy = YS.indexOf(y);
  while (ix !== XS.indexOf(tx)) {
    ix += Math.sign(XS.indexOf(tx) - ix);
    result.push({ x: XS[ix], y: YS[iy] });
  }
  while (iy !== YS.indexOf(ty)) {
    iy += Math.sign(YS.indexOf(ty) - iy);
    result.push({ x: XS[ix], y: YS[iy] });
  }
  result.push({ x: to.x, y: to.y });
  return result;
}
export function clearLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  radius = 24,
): boolean {
  const n = Math.ceil(distance(a, b) / 20);
  for (let i = 1; i <= n; i++)
    if (
      !world.free(
        a.x + ((b.x - a.x) * i) / n,
        a.y + ((b.y - a.y) * i) / n,
        radius,
      )
    )
      return false;
  return true;
}
