// Blackiron: a 2D, web-first game engine.
//
//   platform  the host seam: time, frames, assets, storage, visibility
//   core      math, rng, tweens, events, tile grids, grid and hex helpers, line of sight, fog of war
//   art       headless pixel painter, materials, sprite registry, imported art, atlas
//   render    Renderer contract; WebGL2, Canvas 2D, native and fake backends
//   kernel    the compiled kernel (Rust: Wasm on the web, a static library natively) and its reference
//   combat    health, teams, hits, explosions, weapons, projectiles, destructible tiles, aim, throws
//   scene     node tree, camera, sprites, tile maps, lights, particles, UI, layout
//   audio     synth sound effects, samples and generative music
//   input     action map, pointer, gamepad
//   save      versioned stores
//   net       sockets and HTTP on every host, a loopback for tests, realtime helpers
//   services  player identity and cloud saves over a pluggable backend
//   app       the App: loop, layout, scene stack
//   shell     settings, save slots, hints and menus a game composes

export * from "./platform/index.ts";
export * from "./core/index.ts";
export * from "./art/index.ts";
export * from "./render/index.ts";
export * from "./kernel/index.ts";
export * from "./physics/index.ts";
export * from "./combat/index.ts";
export * from "./scene/index.ts";
export * from "./audio/index.ts";
export * from "./input/index.ts";
export * from "./save/index.ts";
export * from "./net/index.ts";
export * from "./services/index.ts";
export * from "./app/index.ts";
export * from "./shell/index.ts";

export const VERSION = "0.20.0";

export * from "./three/index.ts";

export * from "./content/index.ts";
