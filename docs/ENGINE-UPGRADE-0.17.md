# Blackiron 0.17 validation

Version 0.17 replaces the legacy engine interfaces together and migrates consumers to
pinned source. It changes engine identity and build contracts; it does not change the
supported rendering feature scope described in the 0.16 documentation.

Executed on 2026-10-09 with Bun 1.3.13 and Rust 1.98.1 on macOS:

- TypeScript checks and 423 engine tests pass, including all shipped Wasm ABIs, migration rollback, identity preservation and extracted source lock verification.
- Three private consumers pass 103 game tests and their TypeScript/web builds. Each has source backups and generic Deploy preparation recipes.
- Five flagship web example builds are byte-identical on repeat. Real-browser 2D, isometric and 3D smoke checks and the FPS input check pass.
- A private consumer's browser check verifies no idle attacks, one Space slash, no replay on release, WebGL output and audible output from the renamed AudioWorklet processor.
- Eleven Rust host tests pass, including legacy-save import. The macOS native persistence acceptance passes process restart and rejected-write handling. V8 desktop builds and three game exports complete.
- The relocated iOS project builds for the simulator and archives for devices unsigned, honoring final bundle/version overrides. Three private game exports complete; concurrent exports create separate frameworks.
- The Android arm64-v8a shared library compiles with the canonical JNI symbols, and a private consumer's debug APK assembles with its existing application ID.

[Machine-readable results](validation/blackiron-0.17.json),
[migration guide](MIGRATION-0.17.md), and [generic build integration](BUILD-INTEGRATION.md).

Signed store uploads and production deployment were not performed. Physical phone
playtesting remains outstanding. Windows/Linux native compilation was not rerun locally.
