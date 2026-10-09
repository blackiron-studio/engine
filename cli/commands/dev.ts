import type { Args } from "../args.ts";
import { loadProject } from "../project.ts";
import { serve } from "../serve.ts";

/** Serve the project in the working directory at "/". */
export async function dev(args: Args): Promise<void> {
  const project = await loadProject();
  await serve([{ prefix: "", project }], { port: args.num("port", 4200), open: args.bool("open") });
}
