import {
  mkdir,
  readFile,
  rename,
  lstat,
  realpath,
  writeFile,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { parseSceneDocument } from "../src/content/scene.ts";
const locks = new Map<string, Promise<void>>();
/** Local authoring endpoint: atomic saves, stale-write rejection, bounded names and same-origin writes. */
export async function sceneStore(
  root: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url),
    name = url.searchParams.get("name") ?? "main";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name))
    return new Response("Invalid scene name", { status: 400 });
  if (!["GET", "PUT"].includes(req.method))
    return new Response("Method not allowed", { status: 405 });
  if (req.method === "PUT" && req.headers.get("origin") !== url.origin)
    return new Response("Same-origin editor writes required", { status: 403 });
  const canonical = await realpath(root),
    dir = resolve(root, "assets/scenes");
  await mkdir(dir, { recursive: true });
  if (!(await realpath(dir)).startsWith(canonical + sep))
    return new Response("Invalid scene directory", { status: 403 });
  const file = resolve(dir, name + ".kiln.json");
  const previous = locks.get(file) ?? Promise.resolve();
  let unlock!: () => void;
  const current = new Promise<void>((r) => (unlock = r));
  locks.set(file, current);
  await previous;
  try {
    const stat = await lstat(file).catch(() => null);
    if (stat?.isSymbolicLink())
      return new Response("Scene symlinks are not editable", { status: 403 });
    const old = stat ? await readFile(file, "utf8") : null,
      revision = old
        ? new Bun.CryptoHasher("sha256").update(old).digest("hex")
        : "new";
    if (req.method === "GET")
      return old
        ? Response.json({ document: parseSceneDocument(old), revision })
        : Response.json({
            revision,
            document: {
              format: "kiln.scene",
              version: 1,
              root: { id: "root", type: "Node3D", children: [] },
            },
          });
    if (req.headers.get("if-match") !== revision)
      return new Response("Scene changed on disk; reload before saving", {
        status: 409,
      });
    const text = await req.text();
    if (text.length > 2 * 1024 * 1024)
      return new Response("Scene too large", { status: 413 });
    const document = parseSceneDocument(text),
      serialized = JSON.stringify(document, null, 2) + "\n",
      temp = file + "." + randomUUID() + ".tmp";
    // Exclusive creation prevents a pre-existing temp symlink from redirecting a save.
    await writeFile(temp, serialized, { flag: "wx" });
    try {
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return Response.json({
      revision: new Bun.CryptoHasher("sha256").update(serialized).digest("hex"),
    });
  } catch (error) {
    return new Response((error as Error).message, { status: 400 });
  } finally {
    unlock();
    if (locks.get(file) === current) locks.delete(file);
  }
}
