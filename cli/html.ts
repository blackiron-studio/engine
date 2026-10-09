import type { KilnConfig } from "../src/app/app.ts";

export interface PageOptions {
  title: string;
  config: Partial<KilnConfig>;
  /** External bundle path, or omit when `inlineScript` is given. */
  scriptSrc?: string;
  inlineScript?: string;
  inlineStyles?: string;
  /** Include the live-reload client. */
  dev?: boolean;
}

const DEV_CLIENT = `
(function () {
  // EventSource reconnects on its own; only an explicit "reload" refreshes the page.
  var es = new EventSource("/dev/events");
  es.onmessage = function (e) { if (e.data === "reload") location.reload(); };
})();`;

/** The page every build ships: a full-viewport stage that the App letterboxes into. */
export function pageHtml(o: PageOptions): string {
  const bg =
    typeof o.config.background === "string" ? o.config.background : "#000";
  const cfg = JSON.stringify(o.config).replace(/</g, "\\u003c");
  const script = o.inlineScript
    ? `<script type="module">${o.inlineScript.replace(/<\/script/gi, "<\\/script")}</script>`
    : `<script type="module" src="${o.scriptSrc ?? "/game.js"}"></script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="${bg}">
<title>${escapeHtml(o.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${bg}; overflow: hidden; }
  .kiln-stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; }
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; outline: none; }
</style>
${o.inlineStyles ? `<style>${o.inlineStyles.replace(/<\/style/gi, "<\\/style")}</style>` : ""}
</head>
<body>
<div class="kiln-stage"><canvas id="kiln" aria-label="${escapeHtml(o.title)}" role="application"></canvas></div>
<script>window.KILN_CONFIG = ${cfg};</script>
${script}${o.dev ? `<script>${DEV_CLIENT}</script>` : ""}
</body>
</html>
`;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}
