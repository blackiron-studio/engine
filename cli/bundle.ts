import type { Project } from "./project.ts";

export interface BundleResult {
  js: string;
  map: string | null;
  ms: number;
}

export interface BundleOptions {
  minify?: boolean;
  sourcemap?: "inline" | "linked" | "none";
  /** Entry file; defaults to the project's entry. */
  entry?: string;
  format?: "esm" | "iife";
}

/** Bundle for the browser or a native host, in memory. */
export async function bundle(p: Project, opts: BundleOptions = {}): Promise<BundleResult> {
  const t0 = performance.now();
  const result = await Bun.build({
    entrypoints: [opts.entry ?? p.entryPath],
    target: "browser",
    format: opts.format ?? "esm",
    minify: opts.minify ?? false,
    sourcemap: opts.sourcemap ?? "none",
    naming: "game.[ext]",
  });
  if (!result.success) {
    const msgs = result.logs.map((l) => String(l)).join("\n");
    throw new Error(`Build failed:\n${msgs}`);
  }
  let js = "";
  let map: string | null = null;
  for (const out of result.outputs) {
    if (out.kind === "entry-point") js = await out.text();
    else if (out.kind === "sourcemap") map = await out.text();
  }
  return { js, map, ms: performance.now() - t0 };
}

export function gzipSize(text: string): number {
  return Bun.gzipSync(Buffer.from(text)).byteLength;
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}
