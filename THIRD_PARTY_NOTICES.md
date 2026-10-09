# Third-party notices

The repository's MIT license applies to Blackiron's engine code, templates and
first-party example content. Dependencies and their embedded code retain their
upstream licenses. `bun.lock`, `kernel/Cargo.lock` and `host/Cargo.lock` pin the
dependency versions; third-party components are not relicensed by Blackiron.

## JavaScript and WebAssembly

`@dimforge/rapier3d-compat` is distributed under Apache-2.0. Its upstream license
is included in `licenses/rapier-js-LICENSE.txt`. The prebuilt physics modules also
contain Rapier and its Rust dependencies.

The audio WebAssembly module includes Symphonia components under MPL-2.0.
The full license is included in `licenses/symphonia-LICENSE.txt`.
Upstream source is available from the versioned crates.io links in the generated
license inventory. Blackiron uses the upstream crates without source changes;
the integration code is in `kernel/src`. Preserve the applicable MPL notices
when distributing the compiled audio module.

## Native hosts and transitive dependencies

Native builds additionally use wgpu, winit, QuickJS and, optionally, V8, along
with audio, input, image and font libraries. Their licenses are included in the
inventory when their packages have been downloaded for the build target.

Regenerate the inventory after dependency or target changes:

```sh
bun install --frozen-lockfile
cargo fetch --locked --manifest-path kernel/Cargo.toml
cargo fetch --locked --manifest-path host/Cargo.toml
bun run check:licenses
```

The collector preserves upstream license and notice texts rather than replacing
them with this summary. It reports missing package sources so a distributor can
fetch the relevant target dependencies before preparing its own bundle.

## Examples

The knight example uses an AI-generated sprite sheet, as documented in its
source and README. Most other demonstration art and audio is procedural.
Configured web fonts are downloaded from their upstream provider at build time;
they are not owned or relicensed by Blackiron. Preserve a downloaded font's
license with the exported application.
