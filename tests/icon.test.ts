import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProject } from "../cli/project.ts";
import { renderIcon } from "../cli/icon.ts";
import { encodePNG } from "../cli/png.ts";
import { iosProjectYAML } from "../cli/commands/ios.ts";
const roots: string[] = [];
async function fixture(ios = {}) {
  const root = await mkdtemp(join(tmpdir(), "blackiron-icon-")); roots.push(root);
  await Bun.write(join(root, "blackiron.json"), JSON.stringify({ name: "Icon", entry: "main.ts", background: "#010203", ios }));
  await Bun.write(join(root, "main.ts"), "export default () => {};");
  return loadProject(root);
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function solid(w: number, h: number, colour: number[]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(colour, i * 4);
  return data;
}
async function atlas(root: string, w: number, h: number, name = "background") {
  await Bun.write(join(root, "atlas.json"), JSON.stringify({ width: w, height: h, sprites: { [name]: { x: 0, y: 0, w, h } } }));
  await Bun.write(join(root, "atlas.bin"), solid(w, h, [200, 100, 50, 255]));
}
const pixel = (data: Uint8Array, size: number, x: number, y: number) => [...data.slice((y * size + x) * 4, (y * size + x + 1) * 4)];
test("oversized 1672x941 fallback stays centered and cannot wrap rows", async () => {
  const p = await fixture(); await atlas(p.root, 1672, 941);
  const { rgba, sprite } = await renderIcon(p, p.root, 1024);
  expect(sprite).toBe("background");
  const dw = Math.round(1024 * .72), dh = Math.round(941 * (1024 * .72 / 1672));
  const ox = Math.floor((1024 - dw) / 2), oy = Math.floor((1024 - dh) / 2);
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const inside = x >= ox && x < ox + dw && y >= oy && y < oy + dh;
    const i = (y * 1024 + x) * 4;
    if (rgba[i] !== (inside ? 200 : 1) || rgba[i + 3] !== 255) throw Error(`Incorrect pixel ${x},${y}`);
  }
});
test("small atlas art keeps crisp integer enlargement", async () => {
  const p = await fixture({ icon: "hero" }); await atlas(p.root, 2, 1, "hero");
  await Bun.write(join(p.root, "atlas.bin"), new Uint8Array([255,0,0,255,0,255,0,255]));
  const { rgba } = await renderIcon(p, p.root, 16);
  expect(pixel(rgba,16,2,5)).toEqual([1,2,3,255]);
  expect(pixel(rgba,16,3,5)).toEqual([255,0,0,255]);
  expect(pixel(rgba,16,7,5)).toEqual([255,0,0,255]);
  expect(pixel(rgba,16,8,5)).toEqual([0,255,0,255]);
  expect(pixel(rgba,16,13,5)).toEqual([1,2,3,255]);
});
test("dedicated 1254px logo fills 1024px icon without atlas files", async () => {
  const p = await fixture({ iconFile: "assets/icon.png" });
  await Bun.write(join(p.root,"assets/icon.png"),encodePNG(1254,1254,solid(1254,1254,[99,121,203,255])));
  const { rgba, sprite } = await renderIcon(p, p.root, 1024);
  expect(sprite).toBeNull();
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] !== 99 || rgba[i + 1] !== 121 || rgba[i + 2] !== 203 || rgba[i + 3] !== 255) throw Error(`Band at pixel ${i / 4}`);
});
test("PNG resampling composites premultiplied alpha without dark fringes", async () => {
  const p = await fixture({ iconFile: "icon.png" });
  await Bun.write(join(p.root,"icon.png"),encodePNG(2,1,new Uint8Array([255,0,0,255,0,0,0,0])));
  const { rgba } = await renderIcon(p,p.root,1);
  expect([...rgba]).toEqual([128,1,2,255]);
});
test("non-square files contain artwork over the opaque background", async () => {
  const p = await fixture({ iconFile: "icon.png" });
  await Bun.write(join(p.root,"icon.png"),encodePNG(20,10,solid(20,10,[255,0,0,128])));
  const { rgba } = await renderIcon(p,p.root,10);
  expect(pixel(rgba,10,0,0)).toEqual([1,2,3,255]);
  expect(pixel(rgba,10,0,2)).toEqual([128,1,1,255]);
  expect(pixel(rgba,10,9,6)).toEqual([128,1,1,255]);
  expect(pixel(rgba,10,9,7)).toEqual([1,2,3,255]);
});
test("explicit missing or ambiguous icon sources reject", async () => {
  const p = await fixture({ icon: "missing" });
  await expect(renderIcon(p,p.root,16)).rejects.toThrow("missing");
  await atlas(p.root,2,2);
  await expect(renderIcon(p,p.root,16)).rejects.toThrow("missing");
  p.config.ios = { iconFile: "missing.png" };
  await expect(renderIcon(p,p.root,16)).rejects.toThrow();
  p.config.ios = { iconFile: "icon.png", icon: "hero" };
  await expect(renderIcon(p,p.root,16)).rejects.toThrow("not both");
});
test("Apple encryption declaration is only emitted when explicitly configured", async () => {
  const p = await fixture();
  expect(iosProjectYAML(p)).not.toContain("ITSAppUsesNonExemptEncryption");
  p.config.ios = { usesNonExemptEncryption: false };
  expect(iosProjectYAML(p)).toContain("ITSAppUsesNonExemptEncryption: false\n        UILaunchScreen:");
  p.config.ios.usesNonExemptEncryption = true;
  expect(iosProjectYAML(p)).toContain("ITSAppUsesNonExemptEncryption: true");
});
