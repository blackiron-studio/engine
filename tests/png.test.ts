import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { crc32, encodePNG } from "../cli/png.ts";

describe("encodePNG", () => {
  test("writes a valid signature, header and inflatable image data", () => {
    const w = 3;
    const h = 2;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = i * 40;
      rgba[i * 4 + 3] = 255;
    }
    const png = encodePNG(w, h, rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(8)).toBe(13);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe("IHDR");
    expect(dv.getUint32(16)).toBe(w);
    expect(dv.getUint32(20)).toBe(h);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    // IHDR crc covers type + data.
    expect(dv.getUint32(29)).toBe(crc32(png.subarray(12, 29)));
    // IDAT follows; inflate it and compare rows.
    const idatLen = dv.getUint32(33);
    expect(String.fromCharCode(...png.subarray(37, 41))).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((w * 4 + 1) * h);
    expect(raw[0]).toBe(0);
    expect(raw[1 + 4]).toBe(40);
  });

  test("crc32 matches the known value for 'IEND'", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });
});
