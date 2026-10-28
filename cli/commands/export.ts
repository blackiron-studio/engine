import { writeExportFile } from "../export-transaction.ts";
import { exportDirectory } from "../export-support.ts";
import { singleFileResources } from "../single-file.ts";
import type { Args } from "../args.ts";
import { gzipSize, kb } from "../bundle.ts";
import { pageHtml } from "../html.ts";
import { loadProject, runtimeConfig, slug } from "../project.ts";
import { buildProject } from "./build.ts";

/** Web export: a normal build, or one self-contained HTML file with the bundle inlined. */
export async function exportWeb(args: Args): Promise<void> {
  const project = await loadProject();
  const file = args.bool("single-file")
    ? exportDirectory(
        project,
        args.str("out", `dist/${slug(project.config.name)}.html`),
      )
    : null;
  if (file && !file.toLowerCase().endsWith(".html"))
    throw Error("Single-file export output must end in .html");
  // A single file must stand alone, so it paints its art at boot rather than fetching an atlas.
  const out = await buildProject(project, { report: true, prebake: !args.bool("single-file") });
  if (!args.bool("single-file")) return;
  const embedded = await singleFileResources(project, out.dist);
  const html = pageHtml({
    title: project.config.name,
    config: { ...runtimeConfig(project), fonts: [] },
    inlineStyles: embedded.styles,
    inlineScript: embedded.script + out.js,
  });
  await writeExportFile(project, file!, html);
  console.log(
    `  single-file ${file!.replace(project.root + "/", "")}  ${kb(html.length)} raw, ${kb(gzipSize(html))} gzipped`,
  );
}
