# Neon Bastion as Blackiron's minimum quality reference

**Historical 0.13 validation.** The later [0.14 foundation upgrade](FOUNDATION-UPGRADE.md) supersedes its native-3D/content limitations and test counts. The earlier results below remain a record of that pass.

9 September 2026. Reference source: `<local-neon-reference>`. The reference was inspected and exercised without modifying it. Highground retains its existing projected island design. Neon remains a separate benchmark; the three flagship games remain Wisp Hollow, Highground and Lumen Salvage.

## Assessment

Neon is real 3D geometry viewed through an orthographic camera, with planar movement and shooting. Its quality comes from a consistent palette, well-proportioned cuboid actors, detailed cover, readable ground markings, a composed interface and coordinated movement/hit effects. It does not need textures, sprites, imported models or a full 3D physics solver to work well.

Blackiron's orthographic `Scene3D` path is appropriate for games of this kind. Its older projected-sprite path remains useful for games such as Highground; whole-sprite depth sorting cannot substitute for per-triangle depth and lighting in a mesh arena. A shared engine can support both, provided their coordinate systems remain explicit.

Build games using reusable Blackiron systems and let those games expose missing capabilities. Rewriting projection, rendering, input, audio and collision for each game would duplicate the work that now belongs in Blackiron. General-purpose editor and export breadth remain separate from this smaller visual/gameplay target.

## Implemented from the comparison

| Reference requirement | Blackiron change and evidence |
| --- | --- |
| Controlled palette and face lighting | Lambert shading, explicit ambient/diffuse balance, optional tone mapping; real GPU pixel checks |
| Differently coloured primitives | Per-instance `Mesh3D.tint`; 400 differently coloured shared cubes in one main draw |
| Ground rings, shadows and attack warnings | Flat annulus/disc geometry; courier, core and patrol markers |
| Fixed isometric view and correct aiming | Equal-axis camera preset, aspect-safe horizontal span, camera-relative ground movement, weapon-plane picking |
| Collision-safe movement and dash | Shared swept-circle XZ controller, exact rounded corners, wall sliding and overlap recovery; integrated into Lumen |
| Readable interaction feedback | Bounded seeded mesh particle pool and camera shake; Lumen pickup/landing/dash/hurt effects and articulated feet |
| Clear game presentation | Lumen opening panel, progress/vitals/dash HUD and perspective/orthographic toggle; Highground HUD, hero animation, contact shadows, selective tree fading and jump forgiveness |
| Reliable input and pause | Cleared stale analog state after focus/poll failure; physical-key aliases no longer reopen a pause menu immediately after Escape resumes it |

See [the 3D API](THREE.md) and each game's README for controls and contracts. The ground helper handles circles against axis-aligned boxes and bounds; full 3D rigid bodies, arbitrary mesh collision, slopes, moving platforms and navigation remain outside that helper.

## A concrete rendering acceptance fixture

`bun run check:neon` builds a reference-style arena using Blackiron's own camera, meshes, materials, instancing and GPU depth. No Neon renderer is embedded. `tests/browser/neon-reference.ts` contains the procedural reconstruction; `scripts/check-neon-reference.ts` drives Chrome and writes evidence under `.blackiron/verification/neon`.

The inspected 1440×900 result contains **319 visible meshes, 4,660 triangles, 11 main draws and one final composition draw**, with zero GL errors. Its camera projection differs from Neon's reference math by less than **0.00003 pixels**. On this Apple M1 Pro / 16 GB Mac, a 60-sample CPU collection/submission measurement was **0.70 ms median / 1.50 ms p95**. This excludes GPU completion and display frame pacing.

This validates a rendering baseline, not a complete combat-game port. The fixture has four articulated actors, omits Neon's world-radial fog and uses full cuboids plus MSAA. There is no claim of pixel-identical artwork, equivalent combat balance or faster total rendering: Neon uses two custom batches, while Blackiron's retained scene uses eleven main draws here. Static geometry merging/upload caching remains a useful performance follow-up.

## Verification

- TypeScript check passes; **339 tests / 17,155 assertions pass**.
- Browser GPU checks pass: exact authored palette pixels, live tint updates, 400 coloured instances in one draw, Lambert response, tone mapping, ring hole, depth, shadows, glyph paging and Wasm capacity.
- All three actual games pass browser startup and Enter/Escape keyboard checks, pause/resume and GPU checks. Lumen's dash and perspective/orthographic switch pass too.
- Desktop native visual verification passes **14 comparisons**, with Lumen explicitly skipped as web-only. Highground's deliberately changed images were reviewed before updating its three baselines; prior images were backed up.
- Highground and Lumen production web builds pass. Native mesh rendering remains unsupported.

The reference's 14 collision checks and deterministic gameplay smoke also pass under Bun. The smoke reaches wave two, damage, defeat and restart; it stubs rendering. Additional inspection found terminal-state/pickup ordering, shortened dash protection, shared render/gameplay randomness, thin-wall tunnelling and expanded-box corner approximations worth guarding against. Blackiron regressions cover thin walls, rounded corners, overlap recovery, nearest cover hits, longer invulnerability preservation, independent effects randomness and physical Escape handling.

Short CPU `App.frame` smoke measurements at 1280×720 were Wisp 1.3/1.6 ms, Highground 0.4/0.7 ms and Lumen 1.8/8.2 ms median/p95. These are short CPU submission samples, with driver/compilation variance, not GPU timings or sustained frame-pacing guarantees. Lumen's sampled scene used 26 main plus 18 shadow draws (56 total including UI/post); Highground used 13 total draws.

```sh
bun run typecheck
bun test
bun run check:3d
bun run check:neon
bun run check:showcases
BLACKIRON_NO_V8=1 bun cli/blackiron.ts verify --host desktop --js quickjs
```

Evidence, prior Highground images and a source archive are retained in `<local-verification-artifacts>`. The browser runner saves both Lumen perspectives under `.blackiron/verification/showcases/lumen`.

## Remaining gates

This establishes browser rendering support for Neon's style and improves the existing games' feel. Full shooter authoring convenience still needs reusable projectile/enemy/prefab composition, replay/soak coverage and stronger static batching. Highground crates remain decorative. Native mesh rendering and wider Godot/Unity parity remain on the [roadmap](ROADMAP.md).
