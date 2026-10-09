import { existsSync } from "node:fs";
import { cp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { Args } from "../args.ts";
import { slug } from "../project.ts";

const TEMPLATES_DIR = resolve(import.meta.dir, "..", "..", "templates");
const ENGINE_ROOT = resolve(import.meta.dir, "..", "..");

export interface TemplateInfo {
  name: string;
  description: string;
}

/** Every directory under `templates/` with the first line of its README as description. */
export async function listTemplates(): Promise<TemplateInfo[]> {
  const out: TemplateInfo[] = [];
  for (const e of await readdir(TEMPLATES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let description = "";
    try {
      const readme = await readFile(join(TEMPLATES_DIR, e.name, "README.md"), "utf8");
      description = readme.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
    } catch {
      /* no readme */
    }
    out.push({ name: e.name, description });
  }
  return out.sort((a, b) => (a.name === "blank" ? -1 : b.name === "blank" ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Copy a template into a new directory and point it at this engine. Templates are kept
 * runnable inside the repo (they reference `../../`), so the scaffold rewrites those
 * references to wherever the new project lives.
 */
export async function scaffold(args: Args): Promise<void> {
  const templates = await listTemplates();
  if (args.bool("list")) {
    for (const t of templates) console.log(`  ${t.name.padEnd(12)} ${t.description}`);
    return;
  }
  const target = args._[0];
  if (!target) throw new Error("Usage: blackiron new <dir> [--template <name>] [--list]");
  const template = args.str("template", "blank");
  if (!templates.some((t) => t.name === template)) {
    throw new Error(`Unknown template "${template}". Available: ${templates.map((t) => t.name).join(", ")}`);
  }
  const dest = resolve(process.cwd(), target);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  await cp(join(TEMPLATES_DIR, template), dest, {
    recursive: true,
    filter: (src) => !/\/(node_modules|dist|atlas|screenshots|\.blackiron|\.kiln)(\/|$)/.test(src),
  });

  const name = slug(target.split("/").pop() ?? target);
  const title = name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  // Sibling projects get a short relative path; anything far away gets the absolute one.
  const rel = relative(await realpath(dest), await realpath(ENGINE_ROOT)).split("\\").join("/");
  const enginePath = rel.split("/").filter((s) => s === "..").length <= 3 ? rel : ENGINE_ROOT;

  const pkgPath = join(dest, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { name: string; scripts?: Record<string, string> };
  pkg.name = name;
  // A project typechecks on its own: the compiler and Bun's types come from its own node_modules.
  (pkg as { devDependencies?: Record<string, string> }).devDependencies = { "@types/bun": "1.4.0", typescript: "5.9.3" };
  pkg.scripts = { ...(pkg.scripts ?? {}), typecheck: "tsc --noEmit -p tsconfig.json" };
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) (pkg.scripts as Record<string, string>)[k] = v.replaceAll("../../cli/blackiron.ts", `${enginePath}/cli/blackiron.ts`);
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const blackironPath = join(dest, "blackiron.json");
  const blackiron = JSON.parse(await readFile(blackironPath, "utf8")) as { name: string };
  blackiron.name = title;
  await writeFile(blackironPath, `${JSON.stringify(blackiron, null, 2)}\n`);

  await writeFile(
    join(dest, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          strict: true,
          noImplicitOverride: true,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          noEmit: true,
          paths: {
            "@blackiron-studio/engine": [`${enginePath}/src/index.ts`],
            "@blackiron-studio/engine/scene/ui": [`${enginePath}/src/scene/ui.ts`],
            "@blackiron-studio/engine/*": [`${enginePath}/src/*/index.ts`],
          },
        },
        include: ["src", "tests"],
      },
      null,
      2,
    )}\n`,
  );

  const readmePath = join(dest, "README.md");
  if (existsSync(readmePath)) {
    const readme = await readFile(readmePath, "utf8");
    await writeFile(readmePath, readme.replace(/^# .*$/m, `# ${title}`));
  }

  const shown = relative(process.cwd(), dest) || ".";
  console.log(`  created ${shown} from the ${template} template\n\n  cd ${shown} && bun run dev\n`);
}
