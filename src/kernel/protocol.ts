// The kernel protocol: a command stream of f32 words the renderer writes each frame, which
// a kernel (the compiled Rust one, or the reference TypeScript one) expands into vertices
// and BEGIN / PASS / DRAW / END commands. Retained batches and particle emitters live in
// the kernel and are drawn with one op each.

export const KERNEL_VERSION = 5;

export const OP = { BEGIN: 1, PASS: 2, TRANSFORM: 3, SPRITE: 4, RECT: 5, GLYPH: 6, BATCH: 7, PARTICLES: 8, END: 9, CLIP: 10, CLIP_END: 11, NODES: 12, PROJECTION: 13, PROJECTION_END: 14, TRANSFORM3: 15, BATCH3: 16, LIGHT: 17, QUAD: 18, MESH: 19 } as const;

/** Floats per vertex: x, y, u, v, r, g, b, a, mode (blend + 4 * material), slot, p0, p1. */
export const FLOATS_PER_VERT = 12;
/** Render targets a PASS op can select. */
export const PASS_ID = { WORLD: 0, LIGHT: 1, OVERLAY: 2, SCRATCH: 3 } as const;
/** How a draw blends: normal, additive (colour without coverage), or erase (multiplies the target by 1 - alpha). */
export const BLEND = { NORMAL: 0, ADDITIVE: 1, ERASE: 2 } as const;
/** What a draw samples: the atlas nearest or linear, the glyph cache, a procedural light, or the light scratch target. */
export const SLOT = { NEAREST: 0, LINEAR: 1, GLYPHS: 2, LIGHT: 3, SCRATCH: 4 } as const;
/** Per-draw fragment effects; p0 and p1 carry their parameters. */
export const MATERIAL = { NONE: 0, FLASH: 1, DISSOLVE: 2, OUTLINE: 3, SILHOUETTE: 4 } as const;
/** The flags word of a draw op: blend in bits 0-1, slot in bits 2-4, material in bits 5-8. */
export const drawFlags = (blend: number, slot = 0, material = 0): number => (blend & 3) | ((slot & 7) << 2) | ((material & 15) << 5);

/** Words each op occupies, including the op code. MESH is its five-word header; add count × 4. */
export const OP_WORDS: Record<number, number> = { 1: 4, 2: 3, 3: 7, 4: 19, 5: 8, 6: 12, 7: 9, 8: 8, 9: 1, 10: 5, 11: 1, 12: 5, 13: 20, 14: 1, 15: 11, 16: 5, 17: 9, 18: 12, 19: 5 };

export const STAT = { VERTICES: 0, COMMANDS: 1, DRAWS: 2, SPRITES: 3, DROPPED: 4, PARTICLES: 5, BATCHES: 6, EMITTERS: 7, COUNT: 8 } as const;

/** Floats per retained-batch instance: x, y, w, h, u0, v0, u1, v1. */
export const BATCH_STRIDE = 8;

/**
 * Floats per world-space batch instance: gx, gy, gz, w, h, ox, oy, u0, v0, u1, v1, tint, alpha,
 * depth bias. Instances are projected and depth-sorted under a projection.
 */
export const BATCH3_STRIDE = 14;

/**
 * A projection: screen x, screen y and the depth key as affine functions of ground (x, y, z),
 * twelve numbers by rows; the camera's 2D affine applies after it.
 */
export type ProjectionMatrix = [number, number, number, number, number, number, number, number, number, number, number, number];

/** Floats per node in a node table. */
export const NODE_WORDS = 32;

/** Word offsets inside a node record (see kernel/src/nodes.rs). */
export const NODE = {
  X: 0, Y: 1, ROT: 2, SX: 3, SY: 4, VX: 5, VY: 6, VROT: 7,
  W: 8, H: 9, OX: 10, OY: 11, U0: 12, V0: 13, U1: 14, V1: 15,
  TINT: 16, ALPHA: 17, FLAGS: 18, LIFE: 19, FRAME: 20, FRAME_COUNT: 21, FPS: 22, FRAME_BASE: 23, BODY: 24, USER: 25,
  Z: 26, VZ: 27, DEPTH_BIAS: 28,
} as const;

export const NODE_FLAG = { ALIVE: 1, ADDITIVE: 2, SMOOTH: 4, HIDDEN: 8, FLIP_X: 16, FLIP_Y: 32, EXPIRES: 64, SHADOW: 128 } as const;

/** What happens to a node's height at zero. */
export const NODE_FLOOR = { NONE: 0, STOP: 1, BOUNCE: 2 } as const;

export const NODE_BOUNDS = { NONE: 0, WRAP: 1, BOUNCE: 2, KILL: 3 } as const;

/** Floats per frame in a table's frame list: w, h, ox, oy, u0, v0, u1, v1. */
export const FRAME_WORDS = 8;

/** Emitter configuration layout in the kernel's scratch buffer. */
export const CFG = {
  RATE: 0, LIFE0: 1, LIFE1: 2, SPEED0: 3, SPEED1: 4, ANGLE0: 5, ANGLE1: 6, GRAVITY: 7, DRAG: 8,
  SIZE0: 9, SIZE1: 10, SIZE_END: 11, ALPHA0: 12, ALPHA1: 13, SPREAD: 14, SPIN: 15, MAX: 16,
  ADDITIVE: 17, SEED: 18, HAS_SPRITE: 19, SPRITE_W: 20, SPRITE_H: 21, SPRITE_OX: 22, SPRITE_OY: 23,
  SPRITE_U0: 24, SPRITE_V0: 25, SPRITE_U1: 26, SPRITE_V1: 27, COLOR_COUNT: 28, COLORS: 29,
} as const;

export type KernelKind = "ts" | "wasm" | "native";

export interface KernelOptions {
  /** Quads per frame the kernel can hold; draws beyond it are dropped and counted. */
  maxQuads?: number;
  /** Words in the command stream. */
  streamWords?: number;
}

export const DEFAULT_MAX_QUADS = 32768;
export const DEFAULT_STREAM_WORDS = 1 << 18;

/**
 * What every kernel offers. Buffers are views over kernel memory: re-read `stream`,
 * `scratch` and the outputs after any create call, since a Wasm kernel's memory can move.
 */
export interface Kernel {
  readonly kind: KernelKind;
  readonly maxQuads: number;
  readonly stream: Float32Array;
  readonly scratch: Float32Array;
  readonly vertices: Float32Array;
  readonly commands: Uint32Array;
  readonly stats: Uint32Array;
  setWhite(u: number, v: number): void;
  run(streamLength: number): void;
  createBatch(capacity: number): number;
  batchData(id: number): Float32Array;
  setBatchCount(id: number, count: number): void;
  destroyBatch(id: number): void;
  /** Reads the configuration from `scratch[0..words]`. */
  createEmitter(words: number): number;
  burst(id: number, n: number, x: number, y: number): void;
  emitterCount(id: number): number;
  clearEmitter(id: number): void;
  destroyEmitter(id: number): void;
  /** Node tables: retained sprites the kernel moves and draws. See scene/nodes.ts. */
  createNodes(capacity: number): number;
  /** The table's records, `capacity * NODE_WORDS` floats. A view where the host allows, else a mirror. */
  nodesData(id: number): Float32Array;
  allocNode(id: number): number;
  freeNode(id: number, index: number): void;
  clearNodes(id: number): void;
  nodeCount(id: number): number;
  /** One past the highest slot in use. */
  nodesHigh(id: number): number;
  stepNodes(id: number, dt: number): void;
  configureNodes(id: number, gx: number, gy: number, damping: number, boundsMode: number, bx: number, by: number, bw: number, bh: number, gz?: number, floor?: number): void;
  /** Reads `words` floats of frames (8 each) from `scratch`. */
  setNodeFrames(id: number, words: number): void;
  /** Reads `words` floats of physics transforms (8 per body) from `scratch`; returns nodes moved. */
  applyNodeTransforms(id: number, words: number): number;
  destroyNodes(id: number): void;
  /** World-space batches: instances in ground units, projected and depth-sorted by the kernel. */
  createBatch3(capacity: number): number;
  batch3Data(id: number): Float32Array;
  setBatch3Count(id: number, count: number): void;
  destroyBatch3(id: number): void;
  /** The atlas region drawn under nodes that ask for a shadow. */
  setShadow(w: number, h: number, ox: number, oy: number, u0: number, v0: number, u1: number, v1: number): void;
  /** Copying hosts only: send records `from..to` of the mirror to the kernel. */
  flushNodes?(id: number, from: number, to: number): void;
  /** Copying hosts only: refresh the mirror from the kernel before reading. */
  pullNodes?(id: number): void;
  destroy(): void;
}

/** Size of one complete command, or zero for an unknown/truncated command. */
export function commandWords(stream: Float32Array, offset: number, length: number): number {
  const op = stream[offset];
  const base = OP_WORDS[op];
  if (!base || offset + base > length) return 0;
  if (op !== OP.MESH) return base;
  const count = stream[offset + 1];
  if (!Number.isSafeInteger(count) || count < 0 || count % 3 !== 0) return 0;
  const words = base + count * 4;
  return offset + words <= length ? words : 0;
}
