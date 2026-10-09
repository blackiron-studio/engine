import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { exportDirectory } from "./export-support.ts";
import type { Project } from "./project.ts";

/** Build beside the destination, then publish with rollback. A lock rejects concurrent writers. */
export async function stageExport<T>(
  project: Project,
  output: string,
  build: (stage: string) => Promise<T>,
  managed?: readonly string[],
): Promise<T> {
  const dir = exportDirectory(project, output),
    parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const lock = join(parent, `.${basename(dir)}.kiln-export-lock`);
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error(
        `Export already in progress: ${dir}. If interrupted, remove ${lock} before retrying.`,
      );
    throw error;
  }
  let stage: string | undefined;
  let preserveRecovery = false;
  try {
    stage = await mkdtemp(join(parent, `.${basename(dir)}.kiln-stage-`));
    const result = await build(stage);
    const backup = join(lock, "previous");
    if (!managed) {
      const hadPrevious = existsSync(dir);
      if (hadPrevious) await rename(dir, backup);
      try {
        await rename(stage, dir);
      } catch (error) {
        if (hadPrevious)
          try {
            await rename(backup, dir);
          } catch (rollback) {
            preserveRecovery = true;
            throw new AggregateError(
              [error, rollback],
              `Export recovery required; previous output is in ${backup}`,
            );
          }
        throw error;
      }
    } else {
      await mkdir(dir, { recursive: true });
      await mkdir(backup);
      const moved: string[] = [],
        published: string[] = [];
      try {
        for (const name of managed) {
          if (existsSync(join(dir, name))) {
            await rename(join(dir, name), join(backup, name));
            moved.push(name);
          }
          await rename(join(stage, name), join(dir, name));
          published.push(name);
        }
      } catch (error) {
        try {
          for (const name of published.reverse())
            await rm(join(dir, name), { recursive: true, force: true });
          for (const name of moved.reverse())
            await rename(join(backup, name), join(dir, name));
        } catch (rollback) {
          preserveRecovery = true;
          throw new AggregateError(
            [error, rollback],
            `Export recovery required; previous files are in ${backup}`,
          );
        }
        throw error;
      }
    }
    return result;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    if (!preserveRecovery) await rm(lock, { recursive: true, force: true });
  }
}

/** A complete HTML replaces the previous file only after its bytes are written. */
export async function writeExportFile(
  project: Project,
  path: string,
  contents: string,
): Promise<void> {
  const file = exportDirectory(project, path),
    parent = dirname(file);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, ".kiln-html-"));
  try {
    const pending = join(temp, "output.html");
    await Bun.write(pending, contents);
    await rename(pending, file);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
