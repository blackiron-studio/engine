import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Args } from "../args.ts";
import { loadProject } from "../project.ts";
import { serve } from "../serve.ts";

/**
 * Run the game's own server script beside the dev server and stop it when the dev server
 * stops. It restarts when the script or anything it imports changes.
 */
export function startGameServer(script: string, cwd = process.cwd()): () => void {
  const path = resolve(cwd, script);
  if (!existsSync(path)) throw new Error(`--server script not found: ${script}`);
  const child = Bun.spawn(["bun", "--watch", path], { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit", env: { ...process.env, BLACKIRON_DEV: "1" } });
  console.log(`  game server: bun --watch ${script} (pid ${child.pid})`);
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    child.kill();
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  void child.exited.then((code) => {
    if (!stopped) console.error(`  game server exited with code ${code}`);
  });
  return stop;
}

/** Serve the project in the working directory at "/". */
export async function dev(args: Args): Promise<void> {
  const project = await loadProject();
  const server = args.flags.server;
  if (server === true) throw new Error("--server requires a script path");
  if (typeof server === "string") startGameServer(server, project.root);
  await serve([{ prefix: "", project }], { port: args.num("port", 4200), open: args.bool("open") });
}
