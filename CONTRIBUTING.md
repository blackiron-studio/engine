# Contributing

Blackiron Engine is under active development. Use issues for bugs and feature
requests, and include a minimal reproduction and your target platform.

For local changes, install the pinned Bun version from `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run check:reproducible
```

Native and GPU validation is a separate manually triggered workflow. See
`.github/workflows/native.yml` for the platform-specific prerequisites and
`docs/ENGINE-UPGRADE-0.16.md` for the verified feature scope.

Keep `kiln.json`, legacy CLI commands and source aliases compatible with existing
projects. Contributions are provided under the repository's MIT license.
