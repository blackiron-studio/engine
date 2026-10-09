// `kiln art`: the art pipeline from the command line.
//
//   kiln art import <sheet.png> --name knight [--out assets] [--cell 300x320] [--key auto|none|#hex]
//                  [--pixel auto|4] [--palette project|none] [--anchor feet|center] [--pad 1]
//                  [--anim idle=0] [--anim walk=down:4,5;up:1;left:2,6;right:3,7] [--mirror attack]
//                  [--event attack:1=hit] [--hold hurt=0.5] [--hitbox 8=20,10,30,40]
//                  [--tolerance 40] [--merge 6] [--min 64] [--shrink 2] [--fps 8]
//   kiln art parts <sheet.png> --frame 3 --name knight-rig [--template humanoid]
//                  --cut head=26,11,29,32 --cut torso=27,40,19,25 ... [--anchor weapon=0.5,0.85]
//   kiln art check [assets]           lint imported sheets against the style bible
//   kiln art brief [--subject "..."] [--height 64] [--poses "idle, walk 2, attack 2"]
//   kiln art tileset <tiles.png> --tile 16 --name ground [--terrain blob|edges|none] [--pixel N] [--key none|#hex]
//
// Import turns a generated or scanned sheet into game pixels: the ground is keyed out, poses are
// found (or cells sliced), the real pixel size is measured and the image resampled to it, colours
// snap to the project's palette, and every frame stands on one baseline in a sheet plus a JSON
// manifest with facings, events and hitboxes that `defineSpriteSet` reads. Parts cuts one frame
// into a rig's parts and works out the bone pivots. Check lints. Brief writes the prompt to hand
// an artist or a generator so what comes back imports cleanly.

import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { artStyle } from "../../src/art/style.ts";
import { type RawImage, normalizeSheet, tagFrames } from "../../src/art/normalize.ts";
import { TEMPLATES } from "../../src/art/rigs.ts";
import { type AutotileMode, terrainMaskOf, terrainTileCount } from "../../src/art/index.ts";
import { cornerKey, keyBackground, shrinkImage } from "../../src/art/normalize.ts";
import type { Facing, SetAnimationSpec } from "../../src/art/spritesets.ts";
import type { Args } from "../args.ts";
import { decodePNG, encodePNG } from "../png.ts";
import { loadProject } from "../project.ts";

const FACING_NAMES = new Set(["down", "up", "left", "right"]);

/** Every value of a repeatable flag, `--flag v` or `--flag=v`. */
function multi(flag: string): string[] {
  const out: string[] = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && argv[i + 1]) out.push(argv[++i]);
    else if (argv[i].startsWith(`--${flag}=`)) out.push(argv[i].slice(flag.length + 3));
  }
  return out;
}

const ints = (s: string): number[] => s.split(",").map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));

interface AnimArg {
  name: string;
  frames?: number[];
  facings?: Partial<Record<Facing, number[]>>;
}

/** `--anim walk=4,5` or `--anim walk=down:4,5;up:1;left:2,6;right:3,7`. */
function animArgs(): AnimArg[] {
  const out: AnimArg[] = [];
  for (const v of multi("anim")) {
    const eq = v.indexOf("=");
    if (eq < 0) continue;
    const name = v.slice(0, eq);
    const spec = v.slice(eq + 1);
    if (!spec.includes(":")) {
      out.push({ name, frames: ints(spec) });
      continue;
    }
    const facings: Partial<Record<Facing, number[]>> = {};
    for (const part of spec.split(";")) {
      const [facing, list] = part.split(":");
      if (FACING_NAMES.has(facing?.trim())) facings[facing.trim() as Facing] = ints(list ?? "");
    }
    out.push({ name, facings });
  }
  return out;
}

/** Frames at 4x on a dark ground, for a look before wiring anything. */
function preview(sheet: RawImage, cell: { w: number; h: number }, count: number): RawImage {
  const k = 4;
  const cols = Math.max(1, Math.floor(sheet.width / cell.w));
  const w = sheet.width * k;
  const h = sheet.height * k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 20;
    data[i + 1] = 26;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const s = (y * sheet.width + x) * 4;
      const border = x % cell.w === 0 || y % cell.h === 0;
      const inCell = Math.floor(x / cell.w) + Math.floor(y / cell.h) * cols < count;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const d = ((y * k + dy) * w + x * k + dx) * 4;
          if (sheet.data[s + 3] > 0) {
            data[d] = sheet.data[s];
            data[d + 1] = sheet.data[s + 1];
            data[d + 2] = sheet.data[s + 2];
            data[d + 3] = 255;
          } else if (border && inCell && (dx === 0 || dy === 0)) {
            data[d] = 50;
            data[d + 1] = 58;
            data[d + 2] = 80;
          }
        }
      }
    }
  }
  return { width: w, height: h, data };
}

async function projectPalette(): Promise<{ palette: string[] | null; outline: string | null; artPath: string | null }> {
  try {
    const project = await loadProject();
    if (project.artPath) {
      await import(project.artPath);
      const style = artStyle();
      return { palette: style?.palette?.length ? style.palette.map(String) : null, outline: (style?.outline as string | undefined) ?? null, artPath: project.artPath };
    }
  } catch {
    /* not inside a project */
  }
  return { palette: null, outline: null, artPath: null };
}

async function readPNG(path: string): Promise<RawImage> {
  const png = decodePNG(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.rgba.buffer, png.rgba.byteOffset, png.rgba.byteLength) };
}

// ---------------------------------------------------------------- import

export async function artImport(args: Args): Promise<void> {
  const file = args._[1];
  if (!file) throw new Error("Usage: kiln art import <sheet.png> [--name prefix] [--out dir] ...");
  const src = resolve(process.cwd(), file);
  if (!existsSync(src)) throw new Error(`${file} does not exist`);
  const name = args.str("name", basename(file).replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9_-]/gi, "-").toLowerCase());
  const outDir = resolve(process.cwd(), args.str("out", "assets"));
  const cellArg = args.str("cell", "");
  const cell = /^\d+x\d+$/i.test(cellArg) ? { w: Number(cellArg.split(/x/i)[0]), h: Number(cellArg.split(/x/i)[1]) } : null;
  const keyArg = args.str("key", "auto");
  const key = keyArg === "auto" ? "auto" : keyArg === "none" ? null : keyArg;
  const pixelArg = args.str("pixel", "auto");
  const pixel = pixelArg === "auto" ? "auto" : Math.max(1, Number(pixelArg));
  const anchor = args.str("anchor", "feet") === "center" ? "center" : "feet";
  const { palette } = args.str("palette", "project") === "project" ? await projectPalette() : { palette: null };

  const image = await readPNG(src);
  const t0 = performance.now();
  const result = normalizeSheet(image, { key, keyTolerance: args.num("tolerance", 40), cell, pixel, palette, anchor, pad: args.num("pad", 1), minBlob: args.num("min", 64), merge: args.num("merge", 6), shrink: args.num("shrink", 1) });
  if (result.frames.length === 0) throw new Error("no poses found; try --key none, a --cell size, or a lower --min");

  // Animations: plain frame lists become Aseprite tags when consecutive; everything goes into
  // meta.animations, which carries facings, mirroring, events and holds.
  const fps = args.num("fps", 8);
  const anims = animArgs();
  const mirror = new Set(multi("mirror"));
  const holds = new Map<string, number>();
  for (const h of multi("hold")) {
    const [n, s] = h.split("=");
    if (n && Number.isFinite(Number(s))) holds.set(n, Number(s));
  }
  const events = new Map<string, Record<string, string>>();
  for (const e of multi("event")) {
    const m = /^([^:]+):(\d+)=(.+)$/.exec(e);
    if (!m) continue;
    const bag = events.get(m[1]) ?? {};
    bag[m[2]] = m[3];
    events.set(m[1], bag);
  }
  const hitboxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const h of multi("hitbox")) {
    const [i, rect] = h.split("=");
    const [x, y, w, hh] = ints(rect ?? "");
    if (i && [x, y, w, hh].every((n) => Number.isFinite(n))) hitboxes[i] = { x, y, w, h: hh };
  }
  const animations: Record<string, SetAnimationSpec> = {};
  const tagged: string[] = [];
  for (const a of anims) {
    const spec: SetAnimationSpec = { fps };
    if (a.facings) spec.facings = a.facings;
    if (a.frames) {
      spec.frames = a.frames;
      if (tagFrames(result.json, a.name, a.frames, fps)) tagged.push(a.name);
    }
    const single = a.frames ? a.frames.length === 1 : Object.values(a.facings ?? {}).every((f) => (f?.length ?? 0) <= 1);
    if (mirror.has(a.name)) spec.mirror = true;
    if (holds.has(a.name)) spec.hold = holds.get(a.name);
    if (events.has(a.name)) spec.events = events.get(a.name);
    spec.loop = !(holds.has(a.name) && single) && !(events.get(a.name) && a.name.match(/attack|hit|hurt|cast|die|death|swing|thrust/));
    if (a.name.match(/attack|hurt|cast|die|death|swing|thrust|victory|pickup/)) spec.loop = false;
    animations[a.name] = spec;
  }
  const meta = result.json.meta as Record<string, unknown>;
  meta.image = `${name}.png`;
  meta.pitch = result.pixel;
  meta.height = Math.max(...result.frames.map((f) => f.h));
  meta.anchor = anchor === "feet" ? [0.5, 1] : [0.5, 0.5];
  if (Object.keys(animations).length) meta.animations = animations;
  if (Object.keys(hitboxes).length) meta.hitboxes = hitboxes;

  await mkdir(outDir, { recursive: true });
  await Bun.write(resolve(outDir, `${name}.png`), encodePNG(result.sheet.width, result.sheet.height, result.sheet.data));
  await Bun.write(resolve(outDir, `${name}.json`), JSON.stringify(result.json, null, 2));
  const pv = preview(result.sheet, result.cell, result.frames.length);
  await Bun.write(resolve(outDir, `${name}.preview.png`), encodePNG(pv.width, pv.height, pv.data));

  const rel = outDir.replace(`${process.cwd()}/`, "");
  console.log(`  ${basename(file)}: ${image.width}x${image.height}, key ${result.key ?? "none (kept alpha)"}, ${result.pixel} source px per game px`);
  console.log(`  ${result.frames.length} frame${result.frames.length === 1 ? "" : "s"}, cell ${result.cell.w}x${result.cell.h}, tallest ${meta.height} px${palette ? `, snapped to the project's ${palette.length}-colour palette` : ""}, in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const f of result.frames) console.log(`    ${String(f.index).padStart(2)}  ${f.w}x${f.h}  from ${f.source.x},${f.source.y} ${f.source.w}x${f.source.h}`);
  const names = Object.keys(animations);
  if (names.length) {
    console.log(`  animations: ${names.map((n) => `${n}${animations[n].facings ? ` (${Object.keys(animations[n].facings as object).join("/")}${animations[n].mirror ? ", mirrored" : ""})` : ""}`).join(", ")}`);
  }
  if (Object.keys(hitboxes).length) console.log(`  hitboxes on frames ${Object.keys(hitboxes).join(", ")}`);
  console.log(`  wrote ${rel}/${name}.png, ${name}.json and ${name}.preview.png`);
  console.log(`\n  In the art module:\n    defineSpriteSet("${name}", "${rel}/${name}.json");`);
  console.log(`  Frames are "${name}.0" … "${name}.${result.frames.length - 1}"${names.length ? `; play "${name}.${names.join(`", "${name}.`)}" on an AnimatedSprite and set its facing` : ""}.`);
  if (tagged.length === 0 && anims.some((a) => a.frames)) console.log(`  (no Aseprite tags: frames were not consecutive; the manifest's animations carry them anyway)`);
}

// ---------------------------------------------------------------- parts

interface Cut {
  part: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cut one frame into rig parts, pack them, and work out the bone pivots from where they sat. */
export async function artParts(args: Args): Promise<void> {
  const file = args._[1];
  if (!file) throw new Error("Usage: kiln art parts <sheet.png> --frame N --name prefix --cut part=x,y,w,h ...");
  const src = resolve(process.cwd(), file);
  if (!existsSync(src)) throw new Error(`${file} does not exist`);
  const name = args.str("name", `${basename(file).replace(/\.[a-z]+$/i, "")}-rig`);
  const outDir = resolve(process.cwd(), args.str("out", "assets"));
  const templateName = args.str("template", "humanoid");
  const template = TEMPLATES[templateName];
  if (!template) throw new Error(`unknown template "${templateName}"; one of ${Object.keys(TEMPLATES).join(", ")}`);
  const cuts: Cut[] = [];
  for (const c of multi("cut")) {
    const [part, rect] = c.split("=");
    const [x, y, w, h] = ints(rect ?? "");
    if (!part || ![x, y, w, h].every((n) => Number.isFinite(n))) throw new Error(`bad --cut "${c}"; expected part=x,y,w,h`);
    cuts.push({ part, x, y, w, h });
  }
  if (cuts.length === 0) throw new Error("no --cut part=x,y,w,h given");
  const anchors: Record<string, [number, number]> = {};
  for (const a of multi("anchor")) {
    const [part, v] = a.split("=");
    const [ax, ay] = (v ?? "").split(",").map(Number);
    if (part && Number.isFinite(ax) && Number.isFinite(ay)) anchors[part] = [ax, ay];
  }

  // The frame: from the sheet's manifest when there is one next to it, else the whole image.
  const image = await readPNG(src);
  const jsonPath = src.replace(/\.png$/i, ".json");
  let frame = { x: 0, y: 0, w: image.width, h: image.height };
  const index = args.num("frame", 0);
  if (existsSync(jsonPath)) {
    const manifest = (await Bun.file(jsonPath).json()) as { frames: { frame: { x: number; y: number; w: number; h: number } }[] };
    const f = manifest.frames[index]?.frame;
    if (!f) throw new Error(`frame ${index} is not in ${basename(jsonPath)} (${manifest.frames.length} frames)`);
    frame = f;
  }
  // Feet origin: bottom centre of the opaque pixels.
  let minX = frame.w;
  let maxX = -1;
  let minY = frame.h;
  let maxY = -1;
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      if (image.data[((frame.y + y) * image.width + frame.x + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("the frame is empty");
  const originX = (minX + maxX + 1) / 2;
  const originY = maxY + 1;
  const height = maxY + 1 - minY;

  // Pack the parts in a row.
  const pad = 1;
  const sheetW = cuts.reduce((s, c) => s + c.w + pad, pad);
  const sheetH = Math.max(...cuts.map((c) => c.h)) + pad * 2;
  const sheet: RawImage = { width: sheetW, height: sheetH, data: new Uint8ClampedArray(sheetW * sheetH * 4) };
  const frames: { filename: string; frame: { x: number; y: number; w: number; h: number }; duration: number }[] = [];
  let cx = pad;
  for (const c of cuts) {
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const sx = frame.x + c.x + x;
        const sy = frame.y + c.y + y;
        if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
        const s = (sy * image.width + sx) * 4;
        const d = ((pad + y) * sheetW + cx + x) * 4;
        sheet.data.set(image.data.subarray(s, s + 4), d);
      }
    }
    frames.push({ filename: c.part, frame: { x: cx, y: pad, w: c.w, h: c.h }, duration: 100 });
    cx += c.w + pad;
  }

  // Pivots: each bone's anchor point in the frame, relative to its parent's, in pixels from the feet.
  const byName = new Map(template.bones.map((b) => [b.name, b]));
  const cutOf = new Map(cuts.map((c) => [c.part, c]));
  const unit = height / template.height;
  const world = new Map<string, [number, number]>();
  const pivots: Record<string, [number, number]> = {};
  const resolveWorld = (boneName: string): [number, number] => {
    const cached = world.get(boneName);
    if (cached) return cached;
    const b = byName.get(boneName);
    if (!b) return [0, 0];
    const parentWorld: [number, number] = b.parent ? resolveWorld(b.parent) : [0, 0];
    const cut = cutOf.get(boneName);
    let w: [number, number];
    if (cut) {
      const a = anchors[boneName] ?? b.anchor;
      w = [cut.x + a[0] * cut.w - originX, cut.y + a[1] * cut.h - originY];
    } else {
      w = [parentWorld[0] + b.x * unit, parentWorld[1] + b.y * unit];
    }
    world.set(boneName, w);
    pivots[boneName] = [Math.round((w[0] - parentWorld[0]) * 100) / 100, Math.round((w[1] - parentWorld[1]) * 100) / 100];
    return w;
  };
  for (const b of template.bones) resolveWorld(b.name);
  const unknown = cuts.filter((c) => !byName.has(c.part)).map((c) => c.part);

  const json = {
    frames,
    meta: { app: "kiln", image: `${name}.png`, size: { w: sheetW, h: sheetH }, scale: "1", rig: { template: templateName, height, pivots, anchors: { ...Object.fromEntries(template.bones.map((b) => [b.name, b.anchor])), ...anchors } } },
  };
  await mkdir(outDir, { recursive: true });
  await Bun.write(resolve(outDir, `${name}.png`), encodePNG(sheet.width, sheet.height, sheet.data));
  await Bun.write(resolve(outDir, `${name}.json`), JSON.stringify(json, null, 2));
  const pv = preview(sheet, { w: sheet.width, h: sheet.height }, 1);
  await Bun.write(resolve(outDir, `${name}.preview.png`), encodePNG(pv.width, pv.height, pv.data));

  const rel = outDir.replace(`${process.cwd()}/`, "");
  console.log(`  frame ${index} of ${basename(file)}: ${height} px tall, feet at ${originX},${originY}; template ${templateName} (${template.bones.length} bones)`);
  for (const c of cuts) console.log(`    ${c.part.padEnd(10)} ${c.w}x${c.h} at ${c.x},${c.y}  pivot ${pivots[c.part]?.join(",") ?? "-"}`);
  const joints = template.bones.filter((b) => !cutOf.has(b.name)).map((b) => b.name);
  if (joints.length) console.log(`  bones without a part (joints): ${joints.join(", ")}`);
  if (unknown.length) console.log(`  parts not in the template (kept as sprites only): ${unknown.join(", ")}`);
  console.log(`  wrote ${rel}/${name}.png, ${name}.json and ${name}.preview.png`);
  console.log(`\n  In the art module:\n    defineRig("${name}", "${rel}/${name}.json");\n  In a scene:\n    const hero = this.world.add(new Rig2D("${name}"));\n    hero.play("walk"); hero.layer("upper", "swing");`);
}

// ---------------------------------------------------------------- check

/** Lint imported sheets: pitch, palette, heights, missing manifests. */
export async function artCheck(args: Args): Promise<void> {
  const dir = resolve(process.cwd(), args._[1] ?? "assets");
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  const { palette } = await projectPalette();
  const paletteSet = new Set((palette ?? []).map((c) => c.toLowerCase()));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  let problems = 0;
  const heights: { name: string; height: number }[] = [];
  for (const f of files) {
    const manifest = (await Bun.file(join(dir, f)).json()) as { frames?: { frame: { x: number; y: number; w: number; h: number } }[]; meta?: Record<string, unknown> };
    if (!manifest.frames || !manifest.meta?.image) continue;
    const pngPath = join(dir, String(manifest.meta.image));
    const lines: string[] = [];
    if (!existsSync(pngPath)) {
      lines.push(`image ${manifest.meta.image} is missing`);
      problems++;
    } else if (paletteSet.size) {
      const img = await readPNG(pngPath);
      const off = new Map<string, number>();
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] < 128) continue;
        const hex = `#${[img.data[i], img.data[i + 1], img.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
        if (!paletteSet.has(hex)) off.set(hex, (off.get(hex) ?? 0) + 1);
      }
      if (off.size) {
        const total = [...off.values()].reduce((a, b) => a + b, 0);
        lines.push(`${off.size} colour${off.size === 1 ? "" : "s"} off the palette (${total} px): ${[...off.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c}×${n}`).join(", ")}${off.size > 5 ? ", …" : ""}; import with --palette project or set style: "palette"`);
        problems++;
      }
    }
    if (manifest.meta.pitch === undefined && !manifest.meta.rig) lines.push("no pitch recorded (imported before 0.11?); re-import to record it");
    const tallest = Math.max(...manifest.frames.map((fr) => fr.frame.h));
    if (!manifest.meta.rig) heights.push({ name: f.replace(/\.json$/, ""), height: Number(manifest.meta.height ?? tallest) });
    if (!manifest.meta.animations && !manifest.meta.frameTags && !manifest.meta.rig) lines.push("no animations in the manifest; pass --anim to kiln art import");
    console.log(`  ${f}: ${manifest.frames.length} frames${manifest.meta.rig ? ` (rig, ${(manifest.meta.rig as { template: string }).template})` : ""}, tallest ${tallest} px${lines.length ? "" : "  ok"}`);
    for (const l of lines) console.log(`    - ${l}`);
  }
  if (heights.length > 1) {
    const hs = heights.map((h) => h.height);
    const spread = Math.max(...hs) / Math.min(...hs);
    if (spread > 1.6) {
      console.log(`  cast heights vary ${spread.toFixed(1)}x (${heights.map((h) => `${h.name} ${h.height}`).join(", ")}); a cast reads as one when heroes and enemies share a scale, use --shrink or --height when importing`);
      problems++;
    }
  }
  if (files.length === 0) console.log(`  no manifests in ${dir}`);
  console.log(problems ? `  ${problems} thing${problems === 1 ? "" : "s"} to look at` : "  all good");
}

// ---------------------------------------------------------------- brief

/** A prompt for an artist or a generator, from the project's style bible. */
export async function artBrief(args: Args): Promise<void> {
  const { palette, outline } = await projectPalette();
  const subject = args.str("subject", "a character");
  const height = args.num("height", 64);
  const poses = args.str("poses", "idle, walk 2 frames, attack 2 frames, hurt, down");
  const pitch = args.num("pitch", 4);
  const lines = [
    `Pixel-art sprite sheet of ${subject}, ${poses}.`,
    `Every pose faces right, feet on one baseline, evenly spaced on a plain ${args.str("ground", "#ff00ff")} ground with clear gaps between poses; nothing touches or overlaps.`,
    `The character stands ${height} pixels tall, drawn at exactly ${pitch}x (${height * pitch} image pixels), where one game pixel is a crisp ${pitch}x${pitch} block: hard edges, no anti-aliasing, no gradients, no blur, no drop shadows, no outline glow.`,
    palette ? `Use only these ${palette.length} colours: ${palette.join(", ")}.` : "Use a small palette of at most 24 flat colours.",
    outline ? `A one-pixel ${outline} outline around the silhouette.` : "A one-pixel dark outline around the silhouette.",
    "Same character, same proportions and same light direction (top-left) in every pose; no text, no labels, no grid lines, no background scenery.",
  ];
  console.log(lines.join("\n"));
  console.log(`\n  Then: kiln art import <file.png> --name <name> --anim idle=0 --anim walk=1,2 ...`);
}

// ---------------------------------------------------------------- tileset

/**
 * Slice a tile sheet into a tile set. With a terrain the tiles must sit in `BLOB_MASKS` order
 * (47) or edge-mask order (16), reading row by row; the seam check then compares every pair of
 * tiles the terrain lays side by side and reports the edges that do not meet.
 */
export async function artTileset(args: Args): Promise<void> {
  const file = args._[1];
  if (!file) throw new Error("Usage: kiln art tileset <tiles.png> --tile 16 [--name prefix] [--terrain blob|edges|none] [--pixel N]");
  const src = resolve(process.cwd(), file);
  if (!existsSync(src)) throw new Error(`${file} does not exist`);
  const name = args.str("name", basename(file).replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9_-]/gi, "-").toLowerCase());
  const outDir = resolve(process.cwd(), args.str("out", "assets"));
  const terrainArg = args.str("terrain", "none");
  const terrain: AutotileMode | null = terrainArg === "blob" || terrainArg === "edges" ? terrainArg : null;
  let image = await readPNG(src);
  const pitch = Math.max(1, args.num("pixel", 1));
  if (pitch > 1) image = shrinkImage(image, pitch);
  const keyArg = args.str("key", "none");
  const key = keyArg === "auto" ? cornerKey(image) : keyArg === "none" ? null : keyArg;
  if (key) keyBackground(image, key, args.num("tolerance", 40));
  const tile = args.num("tile", 16);
  if (tile < 2 || image.width < tile || image.height < tile) throw new Error(`--tile ${tile} does not fit a ${image.width}x${image.height} image`);
  const cols = Math.floor(image.width / tile);
  const rows = Math.floor(image.height / tile);
  const max = terrain ? terrainTileCount(terrain) : cols * rows;
  const count = Math.min(cols * rows, max);
  if (terrain && cols * rows < max) console.log(`  warning: a ${terrain} terrain needs ${max} tiles, the sheet has ${cols * rows}`);

  // Repack tight, in reading order.
  const outCols = Math.min(cols, count);
  const outRows = Math.ceil(count / outCols);
  const sheet: RawImage = { width: outCols * tile, height: outRows * tile, data: new Uint8ClampedArray(outCols * tile * outRows * tile * 4) };
  const frames: { filename: string; frame: { x: number; y: number; w: number; h: number }; duration: number }[] = [];
  const tileAt = (i: number) => ({ sx: (i % cols) * tile, sy: Math.floor(i / cols) * tile });
  const empties: number[] = [];
  const hashes = new Map<string, number>();
  const dupes: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const { sx, sy } = tileAt(i);
    const dx = (i % outCols) * tile;
    const dy = Math.floor(i / outCols) * tile;
    let opaque = 0;
    let hash = 0;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const s = ((sy + y) * image.width + sx + x) * 4;
        const d = ((dy + y) * sheet.width + dx + x) * 4;
        sheet.data[d] = image.data[s];
        sheet.data[d + 1] = image.data[s + 1];
        sheet.data[d + 2] = image.data[s + 2];
        sheet.data[d + 3] = image.data[s + 3];
        if (image.data[s + 3] > 0) opaque++;
        hash = (hash * 31 + image.data[s] * 7 + image.data[s + 1] * 13 + image.data[s + 2] * 17 + image.data[s + 3]) >>> 0;
      }
    }
    if (opaque === 0) empties.push(i);
    const k = `${hash}:${opaque}`;
    const seen = hashes.get(k);
    if (seen !== undefined && opaque > 0) dupes.push([seen, i]);
    else hashes.set(k, i);
    frames.push({ filename: String(i), frame: { x: dx, y: dy, w: tile, h: tile }, duration: 100 });
  }

  // Seams: for tiles the terrain joins, the touching edges must be the same run of pixels.
  const seams: string[] = [];
  if (terrain) {
    const edge = (i: number, side: "n" | "e" | "s" | "w") => {
      const { sx, sy } = tileAt(i);
      const px: number[] = [];
      for (let k = 0; k < tile; k++) {
        const x = side === "e" ? sx + tile - 1 : side === "w" ? sx : sx + k;
        const y = side === "s" ? sy + tile - 1 : side === "n" ? sy : sy + k;
        const o = (y * image.width + x) * 4;
        px.push(image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]);
      }
      return px;
    };
    const differ = (a: number[], b: number[]) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
      return n;
    };
    for (let i = 0; i < count; i++) {
      const mi = terrainMaskOf(terrain, i);
      for (let j = 0; j < count; j++) {
        const mj = terrainMaskOf(terrain, j);
        // i joins east and j joins west: their shared edge must match.
        if (mi & 4 && mj & 64) {
          const d = differ(edge(i, "e"), edge(j, "w"));
          if (d > tile * 0.25) seams.push(`${i} east / ${j} west: ${d} px differ`);
        }
        if (mi & 16 && mj & 1) {
          const d = differ(edge(i, "s"), edge(j, "n"));
          if (d > tile * 0.25) seams.push(`${i} south / ${j} north: ${d} px differ`);
        }
      }
    }
  }

  const json = { frames, meta: { app: "kiln", image: `${name}.png`, size: { w: sheet.width, h: sheet.height }, scale: "1", tiles: { size: tile, cols: outCols, rows: outRows, terrain, pitch } } };
  await mkdir(outDir, { recursive: true });
  await Bun.write(resolve(outDir, `${name}.png`), encodePNG(sheet.width, sheet.height, sheet.data));
  await Bun.write(resolve(outDir, `${name}.json`), JSON.stringify(json, null, 2));
  const pv = preview(sheet, { w: tile, h: tile }, count);
  await Bun.write(resolve(outDir, `${name}.preview.png`), encodePNG(pv.width, pv.height, pv.data));
  const rel = outDir.replace(`${process.cwd()}/`, "");
  console.log(`  ${basename(file)}: ${image.width}x${image.height}${pitch > 1 ? ` after /${pitch}` : ""}, ${tile}px tiles, ${count} tile${count === 1 ? "" : "s"}${terrain ? ` as a ${terrain} terrain` : ""}`);
  if (empties.length) console.log(`  empty tiles: ${empties.join(", ")}`);
  if (dupes.length) console.log(`  identical tiles: ${dupes.map(([a, b]) => `${a}=${b}`).join(", ")}`);
  if (terrain) console.log(seams.length ? `  seams that do not meet (${seams.length}):\n    ${seams.slice(0, 12).join("\n    ")}${seams.length > 12 ? "\n    …" : ""}` : "  every joined edge meets its neighbour");
  console.log(`  wrote ${rel}/${name}.png, ${name}.json and ${name}.preview.png`);
  console.log(`\n  In the art module:\n    defineTileSet("${name}", "${rel}/${name}.json");`);
  console.log(terrain ? `  In a TileMap:\n    tiles: { 1: { autotile: "${name}" } }` : `  Tiles are "${name}.0" … "${name}.${count - 1}".`);
}

export async function art(args: Args): Promise<void> {
  const sub = args._[0];
  if (sub === "import") return artImport(args);
  if (sub === "tileset") return artTileset(args);
  if (sub === "parts") return artParts(args);
  if (sub === "check") return artCheck(args);
  if (sub === "brief") return artBrief(args);
  throw new Error(`Usage: kiln art import|parts|tileset|check|brief ...`);
}
