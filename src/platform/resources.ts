/** Resolve resources embedded by Blackiron's single-file exporter without patching global fetch. */
export function resourceUrl(url: string): string {
  const assets = (
    globalThis as { BLACKIRON_BUNDLED_ASSETS?: Record<string, string> }
  ).BLACKIRON_BUNDLED_ASSETS;
  if (!assets) return url;
  if (Object.hasOwn(assets, url)) return assets[url];
  if (typeof document === "undefined") return url;
  const requested = new URL(url, document.baseURI).href;
  for (const [path, data] of Object.entries(assets))
    if (new URL(path, document.baseURI).href === requested) return data;
  return url;
}
export function fetchResource(url: string): Promise<Response> {
  return fetch(resourceUrl(url));
}
