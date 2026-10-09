import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadProject } from "../cli/project.ts";
import { buildNative } from "../cli/commands/build.ts";
import { decodePNG } from "../cli/png.ts";
const engine = resolve(import.meta.dir, ".."),
  out = join(engine, ".kiln/verification/native-fps");
await mkdir(out, { recursive: true });
const bundle = await buildNative(
  await loadProject(join(engine, "tests/fixtures/nativefps")),
);
const build = Bun.spawn(
  [
    "cargo",
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    join(engine, "host/Cargo.toml"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw Error("Native host build failed");
const results = [];
for (const [name, frame] of [
  ["viewmodel", 10],
  ["world", 90],
] as const) {
  const proc = Bun.spawn(
    [
      join(
        engine,
        `host/target/release/kiln-host${process.platform === "win32" ? ".exe" : ""}`,
      ),
      bundle.dir,
      "--js",
      "quickjs",
      "--size",
      "1280x720",
      "--snapshot",
      join(out, name + ".png"),
      "--snapshot-frame",
      String(frame),
      "--fixed-dt",
      "16.666666666666668",
      "--exit",
    ],
    {
      stdout: Bun.file(join(out, name + ".stdout.log")),
      stderr: Bun.file(join(out, name + ".stderr.log")),
      env: { ...process.env, RUST_LOG: "info" },
    },
  );

  let deadline: ReturnType<typeof setTimeout>;
  try {
    const code = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(Error("Native FPS acceptance timed out")),
          180000,
        );
      }),
    ]);
    const log =
      (await Bun.file(join(out, name + ".stdout.log")).text()) +
      (await Bun.file(join(out, name + ".stderr.log")).text());
    await Bun.write(join(out, name + ".log"), log);
    if (
      code !== 0 ||
      !log.includes("NATIVE_FPS_MISSION_PASS") ||
      /ERROR/.test(log)
    )
      throw Error("Native FPS mission failed: " + log.slice(-3000));
    const image = decodePNG(
      new Uint8Array(await Bun.file(join(out, name + ".png")).arrayBuffer()),
    );
    const pixel = [
      ...image.rgba.slice(
        (Math.floor(image.height / 2) * image.width +
          Math.floor(image.width / 2)) *
          4,
        (Math.floor(image.height / 2) * image.width +
          Math.floor(image.width / 2)) *
          4 +
          4,
      ),
    ];
    if (
      name === "viewmodel"
        ? !(pixel[2] > 150 && pixel[0] < 80)
        : !(pixel[0] > 150 && pixel[2] < 80)
    )
      throw Error("Incorrect native depth layer: " + pixel);
    results.push({
      name,
      status: "PASS",
      pixel,
      adapter: log.split("\n").find((l) => l.includes("gpu:")),
    });
  } finally {
    clearTimeout(deadline!);
    proc.kill();
    await proc.exited;
  }
}
const report = {
  status: "PASS",
  checks: [
    "full shared FPS mission",
    "movement/jump/staircase",
    "three combat waves and relays",
    "pause/reload/defeat/restarts",
    "viewmodel depth and world occlusion",
  ],
  results,
};
await Bun.write(join(out, "result.json"), JSON.stringify(report, null, 2));
console.log(report);
