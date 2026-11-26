/**
 * Headless screenshots of any project, with no visible window.
 *
 *   bun scripts/shoot.ts <project dir> [--steps "frames:3;key:Enter;frames:60;shot:play"]
 *                        [--size 1280x720] [--dpr 2] [--device iphone-15] [--out dir] [--seed 7]
 *
 * Steps are described in cli/shoot.ts. Default steps: frames:60;shot:title;key:Enter;frames:90;shot:play.
 * `--device` shows the game as on a phone or tablet (see DEVICES in src/app/screen.ts); for every
 * device at once with a size audit, use `blackiron screens`.
 */
import { join, resolve } from "node:path";
import { DEFAULT_STEPS, shoot } from "../cli/shoot.ts";
import { devicePreset } from "../src/app/screen.ts";

const engine = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const target = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--")));
if (!target) throw new Error("usage: bun scripts/shoot.ts <project dir> [--steps ...] [--size WxH] [--dpr N] [--device name] [--out dir]");
const root = resolve(process.cwd(), target);
const config = await Bun.file(join(root, "blackiron.json")).json();
const [width, height] = flag("size", `${config.viewport?.width ?? 1280}x${config.viewport?.height ?? 720}`).split("x").map(Number);
const device = flag("device", "");
const out = resolve(process.cwd(), flag("out", join(engine, ".blackiron/shots", root.split("/").at(-1)!)));
const result = await shoot({
  root,
  config,
  out,
  steps: flag("steps", DEFAULT_STEPS),
  seed: Number(flag("seed", "7")),
  width,
  height,
  dpr: Number(flag("dpr", "2")),
  device: device ? devicePreset(device, config.ios?.orientation === "portrait" ? "portrait" : undefined) : undefined,
});
console.log(JSON.stringify({ name: config.name, out, ...result, shots: result.shots.map((s) => s.name) }));
