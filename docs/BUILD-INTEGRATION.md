# Generic Code, Deploy and Games integration

The engine repository contains reusable runtime code, templates and examples. Keep studio
games in private Code projects. Deploy consumes the game snapshot with its pinned engine
dependency; Games associates the resulting build and target with the game release.

Use sibling source directories in the build workspace:

```text
workspace/
  app/                 private game snapshot, blackiron.json
  blackiron-engine/    pinned public engine source snapshot
```

Record the engine repository, exact commit, version and source digest in
`blackiron-engine.lock.json` using the engine's `engine-lock --update` command.
Code's dependency snapshot must be created from that same commit and extracted at
`blackiron-engine/`. Keep the engine snapshot ID in Code dependency metadata alongside
the game snapshot, rather than resolving a moving branch at build time.

```json
{
  "dependencies": [{
    "slug": "blackiron-engine",
    "path": "blackiron-engine",
    "snapshot_id": "<snapshot-of-the-pinned-engine-commit>"
  }]
}
```

Generic preparation commands, run with the game as the working directory:

```sh
bun install --frozen-lockfile --cwd ../blackiron-engine
bun install --frozen-lockfile
bun ../blackiron-engine/cli/blackiron.ts engine-lock
bun test
bun ../blackiron-engine/cli/blackiron.ts export ios --signing external --out dist/ios
```

Use `pipeline.prepare` command arrays and `pipeline.build_directory` in generic Deploy
target configuration. Private consumers include ready recipes under `deploy/`.
Set Deploy's build directory to `dist/ios`. Read `dist/ios/blackiron-export.json` for
the relative Xcode project and scheme, default bundle ID, version, build number and
signing mode. Build providers supply signing credentials and archive-time overrides.
Keep those credentials out of engine code and project snapshots.

For web use `blackiron build`; for macOS use `blackiron export desktop`; for Android
use `blackiron export android`. The engine's declared target support and SDK prerequisites
still apply. Exporting an Xcode/Gradle project is distinct from signing or publishing it.

Code stores source and dependency snapshots. Deploy executes generic prepare/build/test
steps and records artifacts/evidence. Games owns game-to-target/release association and
promotion readiness. These applications should consume manifest metadata and pipeline
recipes; none needs a hard-coded Blackiron runtime or access to public game source.

The bundled Codemagic adapter can run a preparation command through `APTEVA_BUILD_CMD`.
Its workflow does not automatically execute every Deploy prepare/test/evidence step;
make the preparation recipe explicit when choosing that provider.
