// A PNG decoder for hosts without an image codec of their own: headless tests and tools.
// 8-bit grey, grey+alpha, RGB and RGBA, non-interlaced. The inflate step is injected so this
// stays free of runtime imports (Bun has one built in, node has zlib).

export type Inflate = (compressed: Uint8Array) => Uint8Array;

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function decodePNG(bytes: Uint8Array, inflate: Inflate): DecodedPng {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a PNG");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = bytes[pos + 16];
      colorType = bytes[pos + 17];
      interlace = bytes[pos + 20];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported`);
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = inflate(joined);
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = out[s + 1];
    } else if (channels === 3) {
      rgba[d] = out[s];
      rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2];
      rgba[d + 3] = 255;
    } else {
      rgba[d] = out[s];
      rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2];
      rgba[d + 3] = out[s + 3];
    }
  }
  return { width, height, rgba };
}
