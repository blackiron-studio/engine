# Migrate to Blackiron 0.17

The public source is [blackiron-studio/engine](https://github.com/blackiron-studio/engine).
Version 0.17 is a breaking rename. There are no legacy command, import or runtime aliases.
Game source, assets, store identities and credentials remain in your private project.

Clone the engine alongside your game as `blackiron-engine`, install its dependencies,
then preview the migration from your game directory:

```sh
bun ../blackiron-engine/cli/blackiron.ts migrate
bun ../blackiron-engine/cli/blackiron.ts migrate --apply
```

Use `--engine /path/to/checkout` for another layout. Preview is the default; it changes
no files. Applying backs up every changed source file under `.blackiron/migrations/`
and archives the previous generated cache there. Source changes since preview,
conflicting destinations and source symlinks are rejected. An interrupted write rolls
back the source changes. Keep the backup until you have verified your game.

The migration updates configuration filenames, imports, CLI recipes, source path mappings,
scene schemas, native bridge references and generated output paths. Project names,
versions, build numbers, bundle/application IDs and literal `key:` save identifiers
are preserved. Review custom persistence identifiers and external integrations yourself;
the migrator cannot infer the meaning of every application-specific string.

| Interface | Before | After |
|---|---|---|
| CLI | `cli/kiln.ts` | `cli/blackiron.ts` |
| Project | `kiln.json` | `blackiron.json` |
| Imports | `@kiln/engine` | `@blackiron-studio/engine` |
| Generated files | `.kiln/` | `.blackiron/` |
| Scenes | `kiln.scene`, `*.kiln.json` | `blackiron.scene`, `*.blackiron.json` |
| Export metadata | `kiln-export.json`, `kiln.export/v1` | `blackiron-export.json`, `blackiron.export/v1` |
| Native resources / framework | `Kiln/`, `KilnKernel` | `Blackiron/`, `BlackironKernel` |
| C/Wasm / host globals | `kiln_*`, `__kiln*`, `KILN_*` | `blackiron_*`, `__blackiron*`, `BLACKIRON_*` |

Rebuild exported native projects and binaries together; mixing old and new ABIs is unsupported.
Desktop hosts copy the previous per-game save into the Blackiron storage directory on
first launch, keeping the original intact. An existing Blackiron save takes precedence.
iOS UserDefaults and Android SharedPreferences keep their game identity and save keys.

After migrating:

```sh
bun install
bun test
bun run build
bun ../blackiron-engine/cli/blackiron.ts export ios --signing unsigned
```

See [generic build integration](BUILD-INTEGRATION.md) for private game snapshots and public engine pins.
