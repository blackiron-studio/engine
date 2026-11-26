// `blackiron screens`: the game on every screen that matters, headless. For each device (iPhone
// SE, iPhone 15, iPad, a laptop, … with their notches and touch) it runs the same steps, saves a
// screenshot at every `shot:`, and measures it: text under `ui.minTextPoints` (11), touch targets
// under `ui.minTouchPoints` (44) and controls running off the screen. It writes report.json and an
// index.html contact sheet, and with --strict fails when anything is too small.

import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DEVICES, type DevicePreset, devicePreset } from "../../src/app/screen.ts";
import type { Args } from "../args.ts";
import { loadProject } from "../project.ts";
import { DEFAULT_STEPS, type ShotResult, shoot } from "../shoot.ts";

export const DEFAULT_DEVICES = ["iphone-se", "iphone-15", "ipad", "laptop"];

/** The presets to run: a name with an orientation is taken as is; otherwise the game's orientation, both when it allows any. */
export function devicesFor(names: string[], orientation: "portrait" | "landscape" | "any"): DevicePreset[] {
  const out: DevicePreset[] = [];
  for (const raw of names.map((n) => n.trim()).filter(Boolean)) {
    if (/-(portrait|landscape)$/.test(raw)) out.push(devicePreset(raw));
    else {
      const touch = DEVICES[raw]?.touch ?? true;
      if (orientation === "any" && touch) out.push(devicePreset(raw, "landscape"), devicePreset(raw, "portrait"));
      else out.push(devicePreset(raw, orientation === "any" ? undefined : orientation));
    }
  }
  return out;
}

const pt = (v: number) => `${v.toFixed(1)} pt`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export interface ScreenRow {
  device: DevicePreset;
  shot: ShotResult;
}

/** One line per shot: what is too small, or that it reads fine. */
export function summarise(row: ScreenRow): string {
  const a = row.shot.audit;
  if (!a) return `${row.device.name} / ${row.shot.name}: not measured`;
  const parts: string[] = [];
  if (a.smallText.length) parts.push(`${a.smallText.length} text${a.smallText.length > 1 ? "s" : ""} under ${a.minTextPoints} pt (smallest ${pt(a.smallText[0].points)} "${a.smallText[0].text}")`);
  if (a.smallTargets.length) {
    const t = a.smallTargets[0];
    parts.push(`${a.smallTargets.length} touch target${a.smallTargets.length > 1 ? "s" : ""} under ${a.minTouchPoints} pt (${t.name} ${t.width.toFixed(0)}×${t.height.toFixed(0)} pt)`);
  }
  const off = row.shot.offscreen ?? [];
  if (off.length) parts.push(`${off.length} control${off.length > 1 ? "s" : ""} off screen (${off[0].name})`);
  const s = a.screen;
  const head = `${row.device.name.padEnd(26)} ${row.shot.name.padEnd(10)} ${(s.pointsPerUnit).toFixed(2)} pt/unit, UI ×${s.uiScale.toFixed(2)}`;
  return `${head}  ${parts.length ? `✗ ${parts.join("; ")}` : "✓ readable"}`;
}

function contactSheet(name: string, out: string, rows: ScreenRow[]): string {
  const cards = rows
    .map(({ device, shot }) => {
      const a = shot.audit;
      const bad = !a || !a.ok || (shot.offscreen?.length ?? 0) > 0;
      const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
      const texts = a ? a.smallText.slice(0, 8).map((t) => `${pt(t.points)}  ${t.text}`) : [];
      const targets = a ? a.smallTargets.slice(0, 6).map((t) => `${t.width.toFixed(0)}×${t.height.toFixed(0)} pt  ${t.name}`) : [];
      const off = (shot.offscreen ?? []).slice(0, 6).map((o) => `off screen: ${o.name}`);
      return `<figure class="${bad ? "bad" : "ok"}"><img src="${esc(relative(out, shot.file))}" alt="${esc(device.name)} ${esc(shot.name)}" style="aspect-ratio:${device.width}/${device.height}"><figcaption><b>${esc(device.name)}</b> · ${esc(shot.name)} · ${device.width}×${device.height} pt${a ? ` · ${a.screen.pointsPerUnit.toFixed(2)} pt per unit · UI ×${a.screen.uiScale.toFixed(2)}` : ""}<br>${bad ? "Too small or off screen:" : "Readable"}${list(texts)}${list(targets)}${list(off)}</figcaption></figure>`;
    })
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)} screens</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 16px; background: #111316; color: #e6e8eb; font: 14px/1.4 system-ui, sans-serif; }
h1 { font-size: 18px; margin: 0 0 12px; }
main { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
figure { margin: 0; background: #1b1e23; border-radius: 8px; padding: 8px; border: 2px solid #2b3038; max-width: min(100%, 560px); }
figure.bad { border-color: #b4483c; }
figure.ok { border-color: #3f8f5a; }
img { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; }
figcaption { margin-top: 6px; font-size: 13px; }
ul { margin: 4px 0 0; padding-left: 18px; color: #f0b3aa; font-variant-numeric: tabular-nums; }
</style></head><body><h1>${esc(name)}: screens</h1><main>
${cards}
</main></body></html>`;
}

export async function screens(args: Args): Promise<void> {
  const root = resolve(args._[0] ?? ".");
  const project = await loadProject(root);
  const config = project.config as typeof project.config & { ui?: { minTextPoints?: number } };
  const vp = config.viewport;
  const orientation = (config.ios?.orientation ?? config.android?.orientation ?? (vp.width >= vp.height ? "landscape" : "portrait")) as "portrait" | "landscape" | "any";
  const devices = devicesFor(args.str("devices", DEFAULT_DEVICES.join(",")).split(","), orientation);
  const steps = args.str("steps", DEFAULT_STEPS);
  const out = resolve(args.str("out", join(project.root, ".blackiron", "screens")));
  const seed = args.num("seed", 7);
  const rows: ScreenRow[] = [];
  for (const device of devices) {
    const result = await shoot({ root: project.root, config, out: join(out, device.name), steps, seed, device, audit: true });
    for (const shot of result.shots) {
      const row = { device, shot };
      rows.push(row);
      console.log(summarise(row));
    }
  }
  const report = rows.map(({ device, shot }) => ({ device, shot: shot.name, file: relative(out, shot.file), audit: shot.audit, offscreen: shot.offscreen }));
  await writeFile(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, "index.html"), contactSheet(config.name ?? "game", out, rows));
  const failing = rows.filter((r) => !r.shot.audit?.ok || (r.shot.offscreen?.length ?? 0) > 0).length;
  console.log(`\n${rows.length} shots on ${devices.length} screens, ${failing} with problems. Contact sheet: ${join(out, "index.html")}`);
  if (failing && args.bool("strict")) process.exitCode = 1;
}
