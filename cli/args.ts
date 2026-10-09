export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  str(name: string, fallback: string): string;
  num(name: string, fallback: number): number;
  bool(name: string): boolean;
}

/** Tiny flag parser: `--name value`, `--name=value`, `--flag`, positionals. */
export function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else _.push(a);
  }
  return {
    _,
    flags,
    str: (n, f) => (typeof flags[n] === "string" ? (flags[n] as string) : f),
    num: (n, f) => (typeof flags[n] === "string" ? Number(flags[n]) : f),
    bool: (n) => flags[n] === true || flags[n] === "true",
  };
}
