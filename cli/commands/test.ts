/** Run `bun test` in the project with any extra arguments passed through. */
export async function test(rest: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", "test", ...rest], { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(await proc.exited);
}
