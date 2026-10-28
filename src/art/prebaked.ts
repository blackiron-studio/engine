// Prebaked atlases for the web. `blackiron build` paints every sprite once at build time and
// ships the atlas as a manifest plus packed RGBA, so the page loads art instead of painting it
// at boot. The packing is PNG's "up" filter (each byte minus the one above it) under gzip,
// which keeps the data exact and compresses about as well as a PNG.

import { Atlas, atlasManifest } from "./atlas.ts";

export interface PrebakedManifest extends ReturnType<typeof atlasManifest> {
  /** Ties the atlas to the bundle built with it; a mismatch means paint at boot instead. */
  id: string;
}

/** Apply the up filter to RGBA rows `width` texels wide, in place on a copy. */
export function filterAtlasRows(data: Uint8Array | Uint8ClampedArray, width: number): Uint8Array<ArrayBuffer> {
  const row = width * 4,
    out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - (i >= row ? data[i - row] : 0)) & 255;
  return out;
}

/** Undo the up filter in place. */
export function unfilterAtlasRows(bytes: Uint8Array, width: number): Uint8Array {
  const row = width * 4;
  for (let i = row; i < bytes.length; i++) bytes[i] = (bytes[i] + bytes[i - row]) & 255;
  return bytes;
}

async function unpack(url: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  // Some hosts serve the file already decompressed; only gunzip what still has the magic.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.length !== width * height * 4) throw new Error(`${url}: expected ${width * height * 4} bytes, got ${bytes.length}`);
  unfilterAtlasRows(bytes, width);
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * Load the atlas a web build shipped at `base` (`base.json`, `base.pack`, `base_n.pack`).
 * Returns null, so the caller paints at boot, when it is missing, from another build, or the
 * browser cannot decompress it.
 */
export async function loadPrebakedAtlas(base: string, id: string): Promise<Atlas | null> {
  if (typeof fetch === "undefined" || typeof DecompressionStream === "undefined") return null;
  try {
    const res = await fetch(`${base}.json`);
    if (!res.ok) return null;
    const manifest = (await res.json()) as PrebakedManifest;
    if (manifest.id !== id) return null;
    const [data, normals] = await Promise.all([
      unpack(`${base}.pack`, manifest.width, manifest.height),
      manifest.normals ? unpack(`${base}_n.pack`, manifest.width, manifest.height) : Promise.resolve(null),
    ]);
    return Atlas.fromManifest(manifest, data, normals);
  } catch (err) {
    console.warn("[blackiron] prebaked atlas unavailable, painting at boot:", String(err));
    return null;
  }
}
