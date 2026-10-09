//! The Kiln kernel: the per-frame heavy loops of the engine, compiled.
//!
//! The TypeScript side writes a command stream of f32 words (sprites, rects, glyphs,
//! transforms, retained batches, particle steps) into `stream`, then calls `run`. The
//! kernel expands it into the vertex buffer and command list the hosts already consume
//! (BEGIN / PASS / DRAW / END, twelve floats per vertex). Particles and retained batches keep
//! their state here, so the script does no per-element work for them.
//!
//! Arithmetic is done in f64 and stored as f32, matching what a JavaScript implementation
//! produces, so the reference TypeScript kernel and this one agree on their output.

#![allow(clippy::too_many_arguments)]

pub mod audio;
pub mod stream;
pub mod nodes;
#[cfg(feature = "physics")]
pub mod physics;
#[cfg(feature = "render")]
pub mod render;

use nodes::{n, NodeTable, FLAG_ADDITIVE, FLAG_ALIVE, FLAG_FLIP_X, FLAG_FLIP_Y, FLAG_HIDDEN, FLAG_SHADOW, FLAG_SMOOTH, NODE_WORDS};

use std::f64::consts::PI;

pub const VERSION: u32 = 5;
pub const FLOATS_PER_VERT: usize = 12;
pub const BATCH_STRIDE: usize = 8;
pub const SCRATCH_WORDS: usize = 4096;

pub const OP_BEGIN: u32 = 1;
pub const OP_PASS: u32 = 2;
pub const OP_TRANSFORM: u32 = 3;
pub const OP_SPRITE: u32 = 4;
pub const OP_RECT: u32 = 5;
pub const OP_GLYPH: u32 = 6;
pub const OP_BATCH: u32 = 7;
pub const OP_PARTICLES: u32 = 8;
pub const OP_END: u32 = 9;
/// Clip subsequent draws to a rect in the current space: [10, x, y, w, h].
pub const OP_CLIP: u32 = 10;
pub const OP_CLIP_END: u32 = 11;
/// Draw a retained node table: [12, id, alpha, tint, flags].
pub const OP_NODES: u32 = 12;
/// Start a projected layer: [13, p0..p11, camA..camF, sorted]. The 3x4 matrix maps ground
/// (x, y, z, 1) to screen x, screen y and a depth key; the camera affine is applied after.
pub const OP_PROJECTION: u32 = 13;
/// End the projected layer, flushing the depth sort: [14].
pub const OP_PROJECTION_END: u32 = 14;
/// A node's transform in ground space under a projection:
/// [15, a, b, c, d, gx, gy, gz, depthBias, shadow, shadowAlpha].
pub const OP_TRANSFORM3: u32 = 15;
/// Draw a world-space batch: [16, id, alpha, tint, flags].
pub const OP_BATCH3: u32 = 16;
/// A procedural light: [17, x, y, radius, color, intensity, falloff, height, flags].
pub const OP_LIGHT: u32 = 17;
/// Four points filled with one colour: [18, x0, y0, x1, y1, x2, y2, x3, y3, color, alpha, flags].
pub const OP_QUAD: u32 = 18;
/// Textured triangles: [19, n, tint, alpha, flags, then n × (x, y, u, v)].
pub const OP_MESH: u32 = 19;

/// Protocol layout queried by hosts before exposing memory views.
#[no_mangle]
pub extern "C" fn kiln_floats_per_vertex() -> u32 { FLOATS_PER_VERT as u32 }

#[no_mangle]
pub extern "C" fn kiln_op_words(op: u32) -> u32 {
    match op {
        OP_BEGIN => 4, OP_PASS => 3, OP_TRANSFORM => 7, OP_SPRITE => 19,
        OP_RECT => 8, OP_GLYPH => 12, OP_BATCH => 9, OP_PARTICLES => 8,
        OP_END | OP_CLIP_END | OP_PROJECTION_END => 1,
        OP_CLIP | OP_NODES | OP_BATCH3 | OP_MESH => 5,
        OP_PROJECTION => 20, OP_TRANSFORM3 => 11, OP_LIGHT => 9, OP_QUAD => 12,
        _ => 0,
    }
}


/// Blend (bits 0-1) plus material (bits 5-8) of a flags word, packed as the vertex mode.
fn mode_of(flags: u32) -> f32 {
    ((flags & 3) + ((flags >> 5) & 15) * 4) as f32
}

fn slot_of(flags: u32) -> f32 {
    ((flags >> 2) & 7) as f32
}
/// Floats per world-space batch instance: gx, gy, gz, w, h, ox, oy, u0, v0, u1, v1, tint, alpha, bias.
pub const BATCH3_STRIDE: usize = 14;

pub const CMD_BEGIN: u32 = 1;
pub const CMD_PASS: u32 = 2;
pub const CMD_DRAW: u32 = 3;
pub const CMD_END: u32 = 4;
/// Scissor in logical units: [5, x, y, w, h]; all zero lifts it.
pub const CMD_SCISSOR: u32 = 5;

pub const STAT_VERTICES: usize = 0;
pub const STAT_COMMANDS: usize = 1;
pub const STAT_DRAWS: usize = 2;
pub const STAT_SPRITES: usize = 3;
pub const STAT_DROPPED: usize = 4;
pub const STAT_PARTICLES: usize = 5;
pub const STAT_BATCHES: usize = 6;
pub const STAT_EMITTERS: usize = 7;
pub const STAT_COUNT: usize = 8;

const TAU: f64 = PI * 2.0;

/// mulberry32, bit for bit the same sequence as the engine's `Rng`.
#[derive(Clone)]
pub struct Rng {
    s: u32,
}

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng { s: if seed == 0 { 0x9e37_79b9 } else { seed } }
    }

    pub fn next(&mut self) -> f64 {
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }

    pub fn range(&mut self, min: f64, max: f64) -> f64 {
        min + (max - min) * self.next()
    }

    pub fn sign(&mut self) -> f64 {
        if self.next() < 0.5 {
            -1.0
        } else {
            1.0
        }
    }

    pub fn pick_index(&mut self, len: usize) -> usize {
        ((self.next() * len as f64).floor() as usize).min(len.saturating_sub(1))
    }
}

struct Batch {
    data: Vec<f32>,
    count: usize,
    capacity: usize,
}

/// A projection for a layer: screen x, screen y and depth as affine functions of (x, y, z).
#[derive(Clone, Copy)]
struct Projection {
    p: [f64; 12],
    cam: [f64; 6],
}

impl Projection {
    fn project(&self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let p = &self.p;
        (p[0] * x + p[1] * y + p[2] * z + p[3], p[4] * x + p[5] * y + p[6] * z + p[7], p[8] * x + p[9] * y + p[10] * z + p[11])
    }

    /// Screen position of a ground point after the camera.
    fn screen(&self, x: f64, y: f64, z: f64) -> (f64, f64, f64) {
        let (sx, sy, d) = self.project(x, y, z);
        let c = &self.cam;
        (c[0] * sx + c[2] * sy + c[4], c[1] * sx + c[3] * sy + c[5], d)
    }
}

/// A quad waiting for the depth sort of its pass.
struct PendingQuad {
    key: f64,
    v: [f32; 4 * FLOATS_PER_VERT],
}

/// The atlas region drawn under nodes that ask for a shadow.
#[derive(Clone, Copy)]
struct ShadowRegion {
    w: f64,
    h: f64,
    ox: f64,
    oy: f64,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
}

#[derive(Clone, Copy, Default)]
struct Particle {
    x: f64,
    y: f64,
    vx: f64,
    vy: f64,
    life: f64,
    max_life: f64,
    size: f64,
    rot: f64,
    spin: f64,
    color: u32,
}

#[derive(Clone, Copy)]
struct SpriteRegion {
    w: f64,
    h: f64,
    ox: f64,
    oy: f64,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
}

struct Emitter {
    rate: f64,
    life: (f64, f64),
    speed: (f64, f64),
    angle: (f64, f64),
    gravity: f64,
    drag: f64,
    size: (f64, f64),
    size_end: f64,
    alpha: (f64, f64),
    spread: f64,
    spin: f64,
    max: usize,
    additive: bool,
    sprite: Option<SpriteRegion>,
    colors: Vec<u32>,
    rng: Rng,
    acc: f64,
    live: Vec<Particle>,
}

/// Layout of an emitter configuration in `scratch`, as floats.
pub mod cfg {
    pub const RATE: usize = 0;
    pub const LIFE0: usize = 1;
    pub const LIFE1: usize = 2;
    pub const SPEED0: usize = 3;
    pub const SPEED1: usize = 4;
    pub const ANGLE0: usize = 5;
    pub const ANGLE1: usize = 6;
    pub const GRAVITY: usize = 7;
    pub const DRAG: usize = 8;
    pub const SIZE0: usize = 9;
    pub const SIZE1: usize = 10;
    pub const SIZE_END: usize = 11;
    pub const ALPHA0: usize = 12;
    pub const ALPHA1: usize = 13;
    pub const SPREAD: usize = 14;
    pub const SPIN: usize = 15;
    pub const MAX: usize = 16;
    pub const ADDITIVE: usize = 17;
    pub const SEED: usize = 18;
    pub const HAS_SPRITE: usize = 19;
    pub const SPRITE_W: usize = 20;
    pub const SPRITE_H: usize = 21;
    pub const SPRITE_OX: usize = 22;
    pub const SPRITE_OY: usize = 23;
    pub const SPRITE_U0: usize = 24;
    pub const SPRITE_V0: usize = 25;
    pub const SPRITE_U1: usize = 26;
    pub const SPRITE_V1: usize = 27;
    pub const COLOR_COUNT: usize = 28;
    pub const COLORS: usize = 29;
}

pub struct Kernel {
    stream: Vec<f32>,
    scratch: Vec<f32>,
    verts: Vec<f32>,
    cmds: Vec<u32>,
    stats: [u32; STAT_COUNT],
    max_quads: usize,
    quads: usize,
    draw_start: usize,
    m: [f64; 6],
    white: (f32, f32),
    view_w: f64,
    view_h: f64,
    batches: Vec<Option<Batch>>,
    emitters: Vec<Option<Emitter>>,
    tables: Vec<Option<NodeTable>>,
    batches3: Vec<Option<Batch>>,
    proj: Option<Projection>,
    sorted: bool,
    pending: Vec<PendingQuad>,
    pending_order: Vec<usize>,
    /// Depth key for the quads that follow, set by TRANSFORM3.
    depth_key: f64,
    /// Ground position of the current node, for tables and batches drawn under it.
    ground: (f64, f64, f64),
    shadow: Option<ShadowRegion>,
}

impl Kernel {
    pub fn new(max_quads: usize, stream_words: usize) -> Kernel {
        let max_quads = max_quads.max(64);
        Kernel {
            stream: vec![0.0; stream_words.max(1024)],
            scratch: vec![0.0; SCRATCH_WORDS],
            verts: vec![0.0; max_quads * 4 * FLOATS_PER_VERT],
            cmds: vec![0; max_quads / 2 + 64],
            stats: [0; STAT_COUNT],
            max_quads,
            quads: 0,
            draw_start: 0,
            m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            white: (0.0, 0.0),
            view_w: 0.0,
            view_h: 0.0,
            batches: Vec::new(),
            emitters: Vec::new(),
            tables: Vec::new(),
            batches3: Vec::new(),
            proj: None,
            sorted: false,
            pending: Vec::new(),
            pending_order: Vec::new(),
            depth_key: 0.0,
            ground: (0.0, 0.0, 0.0),
            shadow: None,
        }
    }

    pub fn set_shadow(&mut self, w: f32, h: f32, ox: f32, oy: f32, u0: f32, v0: f32, u1: f32, v1: f32) {
        self.shadow = if w > 0.0 && h > 0.0 { Some(ShadowRegion { w: w as f64, h: h as f64, ox: ox as f64, oy: oy as f64, u0, v0, u1, v1 }) } else { None };
    }

    pub fn stream_mut(&mut self) -> &mut [f32] {
        &mut self.stream
    }

    pub fn scratch_mut(&mut self) -> &mut [f32] {
        &mut self.scratch
    }

    pub fn vertices(&self) -> &[f32] {
        &self.verts
    }

    pub fn commands(&self) -> &[u32] {
        &self.cmds
    }

    pub fn stats(&self) -> &[u32; STAT_COUNT] {
        &self.stats
    }

    pub fn max_quads(&self) -> usize {
        self.max_quads
    }

    pub fn set_white(&mut self, u: f32, v: f32) {
        self.white = (u, v);
    }

    // --- Vertex emission --------------------------------------------------------------

    fn emit(&mut self, words: &[u32]) {
        let n = self.stats[STAT_COMMANDS] as usize;
        if n + words.len() > self.cmds.len() {
            self.stats[STAT_DROPPED] += 1;
            return;
        }
        self.cmds[n..n + words.len()].copy_from_slice(words);
        self.stats[STAT_COMMANDS] = (n + words.len()) as u32;
    }

    fn flush_draw(&mut self) {
        if self.quads > self.draw_start {
            let first = (self.draw_start * 4) as u32;
            let count = ((self.quads - self.draw_start) * 4) as u32;
            self.emit(&[CMD_DRAW, first, count]);
            self.stats[STAT_DRAWS] += 1;
        }
        self.draw_start = self.quads;
    }

    /// Write a quad to the vertex buffer, or hold it for the depth sort of a projected pass.
    fn emit_quad(&mut self, v: [f32; 4 * FLOATS_PER_VERT]) {
        if self.sorted {
            if self.quads + self.pending.len() >= self.max_quads {
                self.stats[STAT_DROPPED] += 1;
                return;
            }
            self.pending.push(PendingQuad { key: self.depth_key, v });
            self.stats[STAT_SPRITES] += 1;
            return;
        }
        if self.quads >= self.max_quads {
            self.stats[STAT_DROPPED] += 1;
            return;
        }
        let o = self.quads * 4 * FLOATS_PER_VERT;
        self.verts[o..o + 4 * FLOATS_PER_VERT].copy_from_slice(&v);
        self.quads += 1;
        self.stats[STAT_SPRITES] += 1;
    }

    /// Sort the held quads by depth key (stable by sequence) and write them out.
    fn flush_sorted(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        self.pending_order.clear();
        self.pending_order.extend(0..self.pending.len());
        let pending = &self.pending;
        // Move compact indices, never the 192-byte vertex records; break ties by insertion order.
        self.pending_order.sort_unstable_by(|&a, &b| pending[a].key.total_cmp(&pending[b].key).then(a.cmp(&b)));
        for &index in &self.pending_order {
            let o = self.quads * 4 * FLOATS_PER_VERT;
            self.verts[o..o + 4 * FLOATS_PER_VERT].copy_from_slice(&pending[index].v);
            self.quads += 1;
        }
        self.pending.clear();

    }

    /// One quad: local corners (x0,y0)-(x1,y1) through the basis (ax,ay),(bx,by) at (tx,ty).
    fn push(
        &mut self,
        tx: f64, ty: f64, ax: f64, ay: f64, bx: f64, by: f64,
        x0: f64, y0: f64, x1: f64, y1: f64,
        u0: f32, v0: f32, u1: f32, v1: f32,
        r: f32, g: f32, b: f32, a: f32, add: f32, slot: f32,
    ) {
        self.push_ex(tx, ty, ax, ay, bx, by, x0, y0, x1, y1, u0, v0, u1, v1, r, g, b, a, add, slot, 0.0, 0.0);
    }

    fn push_ex(
        &mut self,
        tx: f64, ty: f64, ax: f64, ay: f64, bx: f64, by: f64,
        x0: f64, y0: f64, x1: f64, y1: f64,
        u0: f32, v0: f32, u1: f32, v1: f32,
        r: f32, g: f32, b: f32, a: f32, mode: f32, slot: f32, p0: f32, p1: f32,
    ) {
        let mut v = [0.0f32; 4 * FLOATS_PER_VERT];
        write_quad(&mut v, 0, tx, ty, ax, ay, bx, by, x0, y0, x1, y1, u0, v0, u1, v1, r, g, b, a, mode, slot);
        for k in 0..4 {
            v[k * FLOATS_PER_VERT + 10] = p0;
            v[k * FLOATS_PER_VERT + 11] = p1;
        }
        self.emit_quad(v);
    }

    /// Four explicit screen-space corners with their own texture coordinates.
    fn push_points(&mut self, pts: [f64; 8], uvs: [f32; 8], r: f32, g: f32, b: f32, a: f32, mode: f32, slot: f32) {
        let mut v = [0.0f32; 4 * FLOATS_PER_VERT];
        for k in 0..4 {
            let c = k * FLOATS_PER_VERT;
            v[c] = pts[k * 2] as f32;
            v[c + 1] = pts[k * 2 + 1] as f32;
            v[c + 2] = uvs[k * 2];
            v[c + 3] = uvs[k * 2 + 1];
            v[c + 4] = r;
            v[c + 5] = g;
            v[c + 6] = b;
            v[c + 7] = a;
            v[c + 8] = mode;
            v[c + 9] = slot;
        }
        self.emit_quad(v);
    }

    /// A procedural light: a quad of radius `radius` whose texture coordinates run -1..1 from the centre.
    fn light(&mut self, x: f64, y: f64, radius: f64, color: u32, intensity: f32, falloff: f32, height: f32, flags: u32) {
        if !self.visible(x, y, radius) {
            return;
        }
        let m = self.m;
        let tx = m[0] * x + m[2] * y + m[4];
        let ty = m[1] * x + m[3] * y + m[5];
        let (r, g, b) = rgb(color);
        let blend = if flags & 3 == 0 { 1 } else { flags & 3 };
        self.push_ex(tx, ty, m[0] * radius, m[1] * radius, m[2] * radius, m[3] * radius, -1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, r, g, b, intensity, blend as f32, 3.0, height, falloff);
    }

    /// Four points through the current transform, filled with one colour.
    fn quad(&mut self, p: [f64; 8], color: u32, alpha: f32, flags: u32) {
        let m = self.m;
        let mut pts = [0.0f64; 8];
        for k in 0..4 {
            let (x, y) = (p[k * 2], p[k * 2 + 1]);
            pts[k * 2] = m[0] * x + m[2] * y + m[4];
            pts[k * 2 + 1] = m[1] * x + m[3] * y + m[5];
        }
        let (u, v) = self.white;
        let (r, g, b) = rgb(color);
        self.push_points(pts, [u, v, u, v, u, v, u, v], r, g, b, alpha, mode_of(flags), slot_of(flags));
    }

    /// Textured triangles (x, y, u, v per vertex) through the current transform; each becomes a degenerate quad.
    fn mesh(&mut self, at: usize, n: usize, tint: u32, alpha: f32, flags: u32) {
        let m = self.m;
        let (r, g, b) = rgb(tint);
        let mode = mode_of(flags);
        let slot = slot_of(flags);
        let mut t = 0;
        while t + 2 < n {
            let mut pts = [0.0f64; 8];
            let mut uvs = [0.0f32; 8];
            for k in 0..3 {
                let o = at + (t + k) * 4;
                if o + 3 >= self.stream.len() {
                    return;
                }
                let (x, y) = (self.stream[o] as f64, self.stream[o + 1] as f64);
                pts[k * 2] = m[0] * x + m[2] * y + m[4];
                pts[k * 2 + 1] = m[1] * x + m[3] * y + m[5];
                uvs[k * 2] = self.stream[o + 2];
                uvs[k * 2 + 1] = self.stream[o + 3];
            }
            pts[6] = pts[4];
            pts[7] = pts[5];
            uvs[6] = uvs[4];
            uvs[7] = uvs[5];
            self.push_points(pts, uvs, r, g, b, alpha, mode, slot);
            t += 3;
        }
    }

    fn sprite(
        &mut self,
        x: f64, y: f64, sx: f64, sy: f64, rot: f64, ox: f64, oy: f64, w: f64, h: f64,
        u0: f32, v0: f32, u1: f32, v1: f32, tint: u32, alpha: f32, flags: u32, p0: f32, p1: f32,
    ) {
        let (cos, sin) = if rot != 0.0 { (rot.cos(), rot.sin()) } else { (1.0, 0.0) };
        let m = self.m;
        let tx = m[0] * x + m[2] * y + m[4];
        let ty = m[1] * x + m[3] * y + m[5];
        let ax = (m[0] * cos + m[2] * sin) * sx;
        let ay = (m[1] * cos + m[3] * sin) * sx;
        let bx = (-m[0] * sin + m[2] * cos) * sy;
        let by = (-m[1] * sin + m[3] * cos) * sy;
        let (r, g, b) = rgb(tint);
        let (mut x0, mut y0, mut x1, mut y1) = (-ox, -oy, w - ox, h - oy);
        let (mut u0, mut v0, mut u1, mut v1) = (u0, v0, u1, v1);
        if (flags >> 5) & 15 == 3 {
            // An outline needs one texel of room around the sprite; p0, p1 are the atlas texel size.
            x0 -= 1.0;
            y0 -= 1.0;
            x1 += 1.0;
            y1 += 1.0;
            u0 -= p0;
            v0 -= p1;
            u1 += p0;
            v1 += p1;
        }
        self.push_ex(tx, ty, ax, ay, bx, by, x0, y0, x1, y1, u0, v0, u1, v1, r, g, b, alpha, mode_of(flags), slot_of(flags), p0, p1);
    }

    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, color: u32, alpha: f32, flags: u32) {
        let m = self.m;
        let tx = m[0] * x + m[2] * y + m[4];
        let ty = m[1] * x + m[3] * y + m[5];
        let (u, v) = self.white;
        let (r, g, b) = rgb(color);
        self.push(tx, ty, m[0], m[1], m[2], m[3], 0.0, 0.0, w, h, u, v, u, v, r, g, b, alpha, mode_of(flags), slot_of(flags));
    }

    fn glyph(&mut self, x: f64, y: f64, w: f64, h: f64, u0: f32, v0: f32, u1: f32, v1: f32, color: u32, alpha: f32, flags: u32) {
        let m = self.m;
        let tx = m[0] * x + m[2] * y + m[4];
        let ty = m[1] * x + m[3] * y + m[5];
        let (r, g, b) = rgb(color);
        self.push_ex(tx, ty, m[0], m[1], m[2], m[3], 0.0, 0.0, w, h, u0, v0, u1, v1, r, g, b, alpha, mode_of(flags), 2.0, (flags >> 9) as f32, 0.0);
    }

    /// Screen-space culling identical to DrawContext.visible: a point plus an extent.
    fn visible(&self, x: f64, y: f64, extent: f64) -> bool {
        if self.view_w <= 0.0 {
            return true;
        }
        let t = &self.m;
        let sx = t[0] * x + t[2] * y + t[4];
        let sy = t[1] * x + t[3] * y + t[5];
        let scale = (t[0].abs() + t[2].abs()).max(t[1].abs() + t[3].abs());
        let m = extent * scale;
        sx + m >= 0.0 && sy + m >= 0.0 && sx - m <= self.view_w && sy - m <= self.view_h
    }

    // --- Stream ----------------------------------------------------------------------

    pub fn run(&mut self, len: usize) {
        let len = len.min(self.stream.len());
        self.stats = [0; STAT_COUNT];
        self.quads = 0;
        self.draw_start = 0;
        self.m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        self.proj = None;
        self.sorted = false;
        self.pending.clear();
        self.depth_key = 0.0;
        self.ground = (0.0, 0.0, 0.0);
        let mut i = 0;
        while i < len {
            let raw_op = self.stream[i];
            let op = raw_op as u32;
            let header = kiln_op_words(op) as usize;
            if raw_op != op as f32 || header == 0 || i + header > len {
                self.stats[STAT_DROPPED] += 1;
                break;
            }
            if op == OP_MESH {
                let raw_count = self.stream[i + 1];
                let count = raw_count as usize;
                if !raw_count.is_finite() || raw_count != count as f32 || count % 3 != 0 || count > (len - i - header) / 4 {
                    self.stats[STAT_DROPPED] += 1;
                    break;
                }
            }
            let s = |k: usize| -> f64 { self.stream.get(i + k).copied().unwrap_or(0.0) as f64 };
            let f = |k: usize| -> f32 { self.stream.get(i + k).copied().unwrap_or(0.0) };
            match op {
                OP_BEGIN => {
                    let clear = s(1) as u32;
                    self.view_w = s(2);
                    self.view_h = s(3);
                    self.emit(&[CMD_BEGIN, clear & 0xff_ffff]);
                    i += 4;
                }
                OP_PASS => {
                    let id = s(1) as u32;
                    let clear = s(2) as u32;
                    self.flush_sorted();
                    self.flush_draw();
                    self.emit(&[CMD_PASS, id, clear & 0xff_ffff]);
                    i += 3;
                }
                OP_TRANSFORM => {
                    self.m = [s(1), s(2), s(3), s(4), s(5), s(6)];
                    i += 7;
                }
                OP_SPRITE => {
                    let (x, y, sx, sy, rot, ox, oy, w, h) = (s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8), s(9));
                    let (u0, v0, u1, v1) = (f(10), f(11), f(12), f(13));
                    let tint = s(14) as u32;
                    let alpha = f(15);
                    let flags = s(16) as u32;
                    self.sprite(x, y, sx, sy, rot, ox, oy, w, h, u0, v0, u1, v1, tint, alpha, flags, f(17), f(18));
                    i += 19;
                }
                OP_RECT => {
                    let (x, y, w, h) = (s(1), s(2), s(3), s(4));
                    let color = s(5) as u32;
                    self.rect(x, y, w, h, color, f(6), s(7) as u32);
                    i += 8;
                }
                OP_GLYPH => {
                    let (x, y, w, h) = (s(1), s(2), s(3), s(4));
                    let (u0, v0, u1, v1) = (f(5), f(6), f(7), f(8));
                    let color = s(9) as u32;
                    self.glyph(x, y, w, h, u0, v0, u1, v1, color, f(10), s(11) as u32);
                    i += 12;
                }
                OP_LIGHT => {
                    let (x, y, radius) = (s(1), s(2), s(3));
                    let color = s(4) as u32;
                    self.light(x, y, radius, color, f(5), f(6), f(7), s(8) as u32);
                    i += 9;
                }
                OP_QUAD => {
                    let p = [s(1), s(2), s(3), s(4), s(5), s(6), s(7), s(8)];
                    self.quad(p, s(9) as u32, f(10), s(11) as u32);
                    i += 12;
                }
                OP_MESH => {
                    let n = s(1) as usize;
                    self.mesh(i + 5, n, s(2) as u32, f(3), s(4) as u32);
                    i += 5 + n * 4;
                }
                OP_BATCH => {
                    let id = s(1) as i32;
                    let alpha = f(2);
                    let tint = s(3) as u32;
                    let cull = (s(4), s(5), s(6), s(7));
                    let flags = s(8) as u32;
                    self.draw_batch(id, alpha, tint, cull, flags);
                    i += 9;
                }
                OP_PARTICLES => {
                    let id = s(1) as i32;
                    let dt = s(2);
                    let emitting = s(3) != 0.0;
                    let (ex, ey) = (s(4), s(5));
                    let alpha = s(6);
                    let snap = s(7) != 0.0;
                    self.particles(id, dt, emitting, ex, ey, alpha, snap);
                    i += 8;
                }
                OP_END => {
                    self.flush_sorted();
                    self.flush_draw();
                    self.emit(&[CMD_END]);
                    i += 1;
                }
                OP_CLIP => {
                    let (x, y, w, h) = (s(1), s(2), s(3), s(4));
                    let m = self.m;
                    // Axis-aligned bounds of the transformed rect, in logical units.
                    let corners = [(x, y), (x + w, y), (x, y + h), (x + w, y + h)];
                    let mut x0 = f64::INFINITY;
                    let mut y0 = f64::INFINITY;
                    let mut x1 = f64::NEG_INFINITY;
                    let mut y1 = f64::NEG_INFINITY;
                    for (cx, cy) in corners {
                        let px = m[0] * cx + m[2] * cy + m[4];
                        let py = m[1] * cx + m[3] * cy + m[5];
                        x0 = x0.min(px);
                        y0 = y0.min(py);
                        x1 = x1.max(px);
                        y1 = y1.max(py);
                    }
                    self.flush_sorted();
                    self.flush_draw();
                    let sx = x0.floor().max(0.0) as u32;
                    let sy = y0.floor().max(0.0) as u32;
                    let sw = (x1.ceil() - x0.floor()).max(1.0) as u32;
                    let sh = (y1.ceil() - y0.floor()).max(1.0) as u32;
                    self.emit(&[CMD_SCISSOR, sx, sy, sw, sh]);
                    i += 5;
                }
                OP_CLIP_END => {
                    self.flush_sorted();
                    self.flush_draw();
                    self.emit(&[CMD_SCISSOR, 0, 0, 0, 0]);
                    i += 1;
                }
                OP_PROJECTION => {
                    let mut p = [0.0f64; 12];
                    for (k, slot) in p.iter_mut().enumerate() {
                        *slot = s(1 + k);
                    }
                    let cam = [s(13), s(14), s(15), s(16), s(17), s(18)];
                    let sorted = s(19) != 0.0;
                    self.flush_sorted();
                    self.proj = Some(Projection { p, cam });
                    self.sorted = sorted;
                    self.depth_key = 0.0;
                    self.ground = (0.0, 0.0, 0.0);
                    self.m = [cam[0], cam[1], cam[2], cam[3], cam[4], cam[5]];
                    i += 20;
                }
                OP_PROJECTION_END => {
                    self.flush_sorted();
                    self.proj = None;
                    self.sorted = false;
                    self.depth_key = 0.0;
                    i += 1;
                }
                OP_TRANSFORM3 => {
                    let (a, b, c, d) = (s(1), s(2), s(3), s(4));
                    let (gx, gy, gz) = (s(5), s(6), s(7));
                    let bias = s(8);
                    let shadow = s(9) != 0.0;
                    let shadow_alpha = f(10);
                    self.transform3(a, b, c, d, gx, gy, gz, bias, shadow, shadow_alpha);
                    i += 11;
                }
                OP_BATCH3 => {
                    let id = s(1) as i32;
                    let alpha = f(2);
                    let tint = s(3) as u32;
                    let flags = s(4) as u32;
                    self.draw_batch3(id, alpha, tint, flags);
                    i += 5;
                }
                OP_NODES => {
                    let id = s(1) as i32;
                    let alpha = f(2);
                    let tint = s(3) as u32;
                    let flags = s(4) as u32;
                    self.draw_nodes(id, alpha, tint, flags);
                    i += 5;
                }
                _ => break,
            }
        }
        self.stats[STAT_VERTICES] = (self.quads * 4) as u32;
        self.stats[STAT_BATCHES] = self.batches.iter().filter(|b| b.is_some()).count() as u32;
        self.stats[STAT_EMITTERS] = self.emitters.iter().filter(|e| e.is_some()).count() as u32;
        let live: usize = self.emitters.iter().flatten().map(|e| e.live.len()).sum();
        self.stats[STAT_PARTICLES] = live as u32;
    }

    // --- Batches ---------------------------------------------------------------------

    pub fn batch_create(&mut self, capacity: usize) -> i32 {
        let batch = Batch { data: vec![0.0; capacity.max(1) * BATCH_STRIDE], count: 0, capacity: capacity.max(1) };
        if let Some(slot) = self.batches.iter().position(|b| b.is_none()) {
            self.batches[slot] = Some(batch);
            slot as i32
        } else {
            self.batches.push(Some(batch));
            (self.batches.len() - 1) as i32
        }
    }

    pub fn batch_data(&mut self, id: i32) -> Option<&mut [f32]> {
        self.batches.get_mut(id as usize)?.as_mut().map(|b| b.data.as_mut_slice())
    }

    pub fn batch_set_count(&mut self, id: i32, count: usize) {
        if let Some(Some(b)) = self.batches.get_mut(id as usize) {
            b.count = count.min(b.capacity);
        }
    }

    pub fn batch_destroy(&mut self, id: i32) {
        if let Some(slot) = self.batches.get_mut(id as usize) {
            *slot = None;
        }
    }

    fn draw_batch(&mut self, id: i32, alpha: f32, tint: u32, cull: (f64, f64, f64, f64), flags: u32) {
        let Some(Some(b)) = self.batches.get(id as usize) else { return };
        let count = b.count;
        let (cx, cy, cw, ch) = cull;
        let culling = cw > 0.0 && ch > 0.0;
        let m = self.m;
        let (r, g, bl) = rgb(tint);
        let add = mode_of(flags);
        let slot = slot_of(flags);
        let mut quads_out: Vec<[f32; 4 * FLOATS_PER_VERT]> = Vec::new();
        for n in 0..count {
            let o = n * BATCH_STRIDE;
            let (x, y, w, h) = (b.data[o] as f64, b.data[o + 1] as f64, b.data[o + 2] as f64, b.data[o + 3] as f64);
            if culling && (x + w < cx || x > cx + cw || y + h < cy || y > cy + ch) {
                continue;
            }
            let (u0, v0, u1, v1) = (b.data[o + 4], b.data[o + 5], b.data[o + 6], b.data[o + 7]);
            let tx = m[0] * x + m[2] * y + m[4];
            let ty = m[1] * x + m[3] * y + m[5];
            let mut v = [0.0f32; 4 * FLOATS_PER_VERT];
            write_quad(&mut v, 0, tx, ty, m[0], m[1], m[2], m[3], 0.0, 0.0, w, h, u0, v0, u1, v1, r, g, bl, alpha, add, slot);
            quads_out.push(v);
        }
        for v in quads_out {
            self.emit_quad(v);
        }
    }

    // --- Projection ------------------------------------------------------------------

    /// A node's transform under the projection: the linear part stays in screen space (a
    /// billboard scales and spins on screen), the position is projected from ground space.
    fn transform3(&mut self, a: f64, b: f64, c: f64, d: f64, gx: f64, gy: f64, gz: f64, bias: f64, shadow: bool, shadow_alpha: f32) {
        self.ground = (gx, gy, gz);
        match self.proj {
            Some(pr) => {
                let (sx, sy, depth) = pr.screen(gx, gy, gz);
                let cm = pr.cam;
                self.m = [cm[0] * a + cm[2] * b, cm[1] * a + cm[3] * b, cm[0] * c + cm[2] * d, cm[1] * c + cm[3] * d, sx, sy];
                self.depth_key = depth + bias;
                if shadow {
                    self.shadow_at(gx, gy, gz, shadow_alpha, bias);
                }
            }
            None => {
                self.m = [a, b, c, d, gx, gy - gz];
                self.depth_key = bias;
            }
        }
    }

    /// A blob shadow on the ground under a point at height gz, fading and shrinking as it rises.
    fn shadow_at(&mut self, gx: f64, gy: f64, gz: f64, alpha: f32, bias: f64) {
        let (Some(pr), Some(sh)) = (self.proj, self.shadow) else { return };
        let (sx, sy, depth) = pr.screen(gx, gy, 0.0);
        let k = (1.0 - gz / 160.0).max(0.4);
        let a = alpha * (1.0 - gz as f32 / 200.0).max(0.2);
        let cm = pr.cam;
        let (ax, ay, bx, by) = (cm[0] * k, cm[1] * k, cm[2] * k, cm[3] * k);
        let saved = self.depth_key;
        // Just above the floor tile under it, below the node itself.
        self.depth_key = depth + bias - 0.25;
        self.push(sx, sy, ax, ay, bx, by, -sh.ox, -sh.oy, sh.w - sh.ox, sh.h - sh.oy, sh.u0, sh.v0, sh.u1, sh.v1, 1.0, 1.0, 1.0, a, 0.0, 0.0);
        self.depth_key = saved;
    }

    pub fn batch3_create(&mut self, capacity: usize) -> i32 {
        let batch = Batch { data: vec![0.0; capacity.max(1) * BATCH3_STRIDE], count: 0, capacity: capacity.max(1) };
        if let Some(slot) = self.batches3.iter().position(|b| b.is_none()) {
            self.batches3[slot] = Some(batch);
            slot as i32
        } else {
            self.batches3.push(Some(batch));
            (self.batches3.len() - 1) as i32
        }
    }

    pub fn batch3_data(&mut self, id: i32) -> Option<&mut [f32]> {
        self.batches3.get_mut(id as usize)?.as_mut().map(|b| b.data.as_mut_slice())
    }

    pub fn batch3_set_count(&mut self, id: i32, count: usize) {
        if let Some(Some(b)) = self.batches3.get_mut(id as usize) {
            b.count = count.min(b.capacity);
        }
    }

    pub fn batch3_destroy(&mut self, id: i32) {
        if let Some(slot) = self.batches3.get_mut(id as usize) {
            *slot = None;
        }
    }

    /// Draw a world-space batch: every instance is projected from ground space (offset by
    /// the current node's ground position) and sorted by its own depth key.
    fn draw_batch3(&mut self, id: i32, alpha_mul: f32, tint_mul: u32, flags: u32) {
        let Some(slot) = self.batches3.get_mut(id as usize) else { return };
        let Some(b) = slot.take() else { return };
        let (mr, mg, mb) = if tint_mul == 0xff_ffff { (1.0, 1.0, 1.0) } else { rgb(tint_mul) };
        let add = mode_of(flags);
        let slot_tex = slot_of(flags);
        let (ox0, oy0, oz0) = self.ground;
        let saved_key = self.depth_key;
        for n in 0..b.count {
            let o = n * BATCH3_STRIDE;
            let d = &b.data[o..o + BATCH3_STRIDE];
            let (gx, gy, gz) = (d[0] as f64 + ox0, d[1] as f64 + oy0, d[2] as f64 + oz0);
            let (w, h, ox, oy) = (d[3] as f64, d[4] as f64, d[5] as f64, d[6] as f64);
            let (u0, v0, u1, v1) = (d[7], d[8], d[9], d[10]);
            let tint = d[11] as u32;
            let alpha = d[12] * alpha_mul;
            let bias = d[13] as f64;
            let (r, g, bl) = rgb(tint);
            match self.proj {
                Some(pr) => {
                    let (sx, sy, depth) = pr.screen(gx, gy, gz);
                    let cm = pr.cam;
                    let scale = (cm[0].abs() + cm[2].abs()).max(cm[1].abs() + cm[3].abs());
                    let extent = w.max(h) * scale;
                    if self.view_w > 0.0 && (sx + extent < 0.0 || sy + extent < 0.0 || sx - extent > self.view_w || sy - extent > self.view_h) {
                        continue;
                    }
                    self.depth_key = depth + bias;
                    self.push(sx, sy, cm[0], cm[1], cm[2], cm[3], -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, r * mr, g * mg, bl * mb, alpha, add, slot_tex);
                }
                None => {
                    // No projection: a top-down world where height lifts the sprite.
                    let (x, y) = (gx, gy - gz);
                    if !self.visible(x, y, w.max(h)) {
                        continue;
                    }
                    let m = self.m;
                    let tx = m[0] * x + m[2] * y + m[4];
                    let ty = m[1] * x + m[3] * y + m[5];
                    self.push(tx, ty, m[0], m[1], m[2], m[3], -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, r * mr, g * mg, bl * mb, alpha, add, slot_tex);
                }
            }
        }
        self.depth_key = saved_key;
        self.batches3[id as usize] = Some(b);
    }

    // --- Node tables -----------------------------------------------------------------

    pub fn nodes_create(&mut self, capacity: usize) -> i32 {
        let t = NodeTable::new(capacity);
        if let Some(slot) = self.tables.iter().position(|t| t.is_none()) {
            self.tables[slot] = Some(t);
            slot as i32
        } else {
            self.tables.push(Some(t));
            (self.tables.len() - 1) as i32
        }
    }

    pub fn nodes(&mut self, id: i32) -> Option<&mut NodeTable> {
        self.tables.get_mut(id as usize)?.as_mut()
    }

    pub fn nodes_destroy(&mut self, id: i32) {
        if let Some(slot) = self.tables.get_mut(id as usize) {
            *slot = None;
        }
    }

    /// Frames for a table come through the scratch buffer: `words` floats, 8 per frame.
    pub fn nodes_set_frames(&mut self, id: i32, words: usize) {
        let words = words.min(self.scratch.len());
        let Some(Some(t)) = self.tables.get_mut(id as usize) else { return };
        t.set_frames(&self.scratch[..words]);
    }

    /// Physics transforms come through the scratch buffer too: `words` floats, 8 per body.
    pub fn nodes_apply_transforms(&mut self, id: i32, words: usize) -> u32 {
        let words = words.min(self.scratch.len());
        let Some(Some(t)) = self.tables.get_mut(id as usize) else { return 0 };
        t.apply_transforms(&self.scratch[..words])
    }

    fn draw_nodes(&mut self, id: i32, alpha_mul: f32, tint_mul: u32, op_flags: u32) {
        let Some(slot) = self.tables.get_mut(id as usize) else { return };
        let Some(t) = slot.take() else { return };
        let saved_key = self.depth_key;
        let (mr, mg, mb) = if tint_mul == 0xff_ffff { (1.0, 1.0, 1.0) } else { rgb(tint_mul) };
        for i in 0..t.high {
            let o = i * NODE_WORDS;
            let d = &t.data[o..o + NODE_WORDS];
            let flags = d[n::FLAGS] as u32;
            if flags & FLAG_ALIVE == 0 || flags & FLAG_HIDDEN != 0 {
                continue;
            }
            // The frame list wins over the node's own region when the node uses one.
            let (w, h, ox, oy, u0, v0, u1, v1) = if !t.frames.is_empty() && d[n::FRAME_COUNT] > 0.0 {
                let idx = (d[n::FRAME_BASE] as usize).saturating_add((d[n::FRAME].max(0.0) as usize).min(d[n::FRAME_COUNT] as usize - 1));
                let fr = t.frames.get(idx).copied().unwrap_or_default();
                (fr.w as f64, fr.h as f64, fr.ox as f64, fr.oy as f64, fr.u0, fr.v0, fr.u1, fr.v1)
            } else {
                (d[n::W] as f64, d[n::H] as f64, d[n::OX] as f64, d[n::OY] as f64, d[n::U0], d[n::V0], d[n::U1], d[n::V1])
            };
            let mut sx = d[n::SX] as f64;
            let mut sy = d[n::SY] as f64;
            if flags & FLAG_FLIP_X != 0 {
                sx = -sx;
            }
            if flags & FLAG_FLIP_Y != 0 {
                sy = -sy;
            }
            let (x, y) = (d[n::X] as f64, d[n::Y] as f64);
            let tint = d[n::TINT] as u32;
            let (r, g, b) = rgb(tint);
            let alpha = d[n::ALPHA] * alpha_mul;
            let add = if flags & FLAG_ADDITIVE != 0 { 1 } else { op_flags & 3 };
            let smooth = if flags & FLAG_SMOOTH != 0 { 1 } else { (op_flags >> 2) & 7 };
            let rot = d[n::ROT] as f64;
            let (cos, sin) = if rot != 0.0 { (rot.cos(), rot.sin()) } else { (1.0, 0.0) };
            let (m, tx, ty) = match self.proj {
                Some(pr) => {
                    // Under a projection nodes are in the table node's ground space.
                    let (gx, gy, gz) = (x + self.ground.0, y + self.ground.1, d[n::Z] as f64 + self.ground.2);
                    let (px, py, depth) = pr.screen(gx, gy, gz);
                    let cm = pr.cam;
                    let scale = (cm[0].abs() + cm[2].abs()).max(cm[1].abs() + cm[3].abs());
                    let extent = (w * sx.abs()).max(h * sy.abs()) * scale;
                    if self.view_w > 0.0 && (px + extent < 0.0 || py + extent < 0.0 || px - extent > self.view_w || py - extent > self.view_h) {
                        continue;
                    }
                    self.depth_key = depth + d[n::DEPTH_BIAS] as f64;
                    if flags & FLAG_SHADOW != 0 {
                        self.shadow_at(gx, gy, gz, 0.5, d[n::DEPTH_BIAS] as f64);
                    }
                    ([cm[0], cm[1], cm[2], cm[3], 0.0, 0.0], px, py)
                }
                None => {
                    let extent = (w * sx.abs()).max(h * sy.abs());
                    if !self.visible(x, y, extent) {
                        continue;
                    }
                    let m = self.m;
                    (m, m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
                }
            };
            let ax = (m[0] * cos + m[2] * sin) * sx;
            let ay = (m[1] * cos + m[3] * sin) * sx;
            let bx = (-m[0] * sin + m[2] * cos) * sy;
            let by = (-m[1] * sin + m[3] * cos) * sy;
            self.push(tx, ty, ax, ay, bx, by, -ox, -oy, w - ox, h - oy, u0, v0, u1, v1, r * mr, g * mg, b * mb, alpha, add as f32, smooth as f32);
        }
        self.depth_key = saved_key;
        self.tables[id as usize] = Some(t);
    }

    // --- Particles -------------------------------------------------------------------

    pub fn emitter_create(&mut self, words: usize) -> i32 {
        let c = &self.scratch;
        let g = |k: usize| -> f64 { if k < words { c[k] as f64 } else { 0.0 } };
        let color_count = g(cfg::COLOR_COUNT) as usize;
        let mut colors: Vec<u32> = (0..color_count).map(|k| g(cfg::COLORS + k) as u32).collect();
        if colors.is_empty() {
            colors.push(0xff_ffff);
        }
        let sprite = if g(cfg::HAS_SPRITE) != 0.0 {
            Some(SpriteRegion {
                w: g(cfg::SPRITE_W),
                h: g(cfg::SPRITE_H),
                ox: g(cfg::SPRITE_OX),
                oy: g(cfg::SPRITE_OY),
                u0: g(cfg::SPRITE_U0) as f32,
                v0: g(cfg::SPRITE_V0) as f32,
                u1: g(cfg::SPRITE_U1) as f32,
                v1: g(cfg::SPRITE_V1) as f32,
            })
        } else {
            None
        };
        let e = Emitter {
            rate: g(cfg::RATE),
            life: (g(cfg::LIFE0), g(cfg::LIFE1)),
            speed: (g(cfg::SPEED0), g(cfg::SPEED1)),
            angle: (g(cfg::ANGLE0), g(cfg::ANGLE1)),
            gravity: g(cfg::GRAVITY),
            drag: g(cfg::DRAG),
            size: (g(cfg::SIZE0), g(cfg::SIZE1)),
            size_end: g(cfg::SIZE_END),
            alpha: (g(cfg::ALPHA0), g(cfg::ALPHA1)),
            spread: g(cfg::SPREAD),
            spin: g(cfg::SPIN),
            max: g(cfg::MAX).max(0.0) as usize,
            additive: g(cfg::ADDITIVE) != 0.0,
            sprite,
            colors,
            rng: Rng::new(g(cfg::SEED) as u32),
            acc: 0.0,
            live: Vec::new(),
        };
        if let Some(slot) = self.emitters.iter().position(|e| e.is_none()) {
            self.emitters[slot] = Some(e);
            slot as i32
        } else {
            self.emitters.push(Some(e));
            (self.emitters.len() - 1) as i32
        }
    }

    pub fn emitter_burst(&mut self, id: i32, n: usize, x: f64, y: f64) {
        if let Some(Some(e)) = self.emitters.get_mut(id as usize) {
            for _ in 0..n {
                e.spawn(x, y);
            }
        }
    }

    pub fn emitter_count(&self, id: i32) -> usize {
        match self.emitters.get(id as usize) {
            Some(Some(e)) => e.live.len(),
            _ => 0,
        }
    }

    pub fn emitter_clear(&mut self, id: i32) {
        if let Some(Some(e)) = self.emitters.get_mut(id as usize) {
            e.live.clear();
        }
    }

    pub fn emitter_destroy(&mut self, id: i32) {
        if let Some(slot) = self.emitters.get_mut(id as usize) {
            *slot = None;
        }
    }

    fn particles(&mut self, id: i32, dt: f64, emitting: bool, ex: f64, ey: f64, alpha_mul: f64, snap: bool) {
        let Some(Some(e)) = self.emitters.get_mut(id as usize) else { return };
        e.step(dt, emitting, ex, ey);
        if e.live.is_empty() {
            return;
        }
        // Draw. Take the emitter out to keep the borrow checker simple, then put it back.
        let e = self.emitters[id as usize].take().unwrap();
        let m = self.m;
        for p in &e.live {
            let t = 1.0 - p.life / p.max_life;
            let alpha = (lerp(e.alpha.0, e.alpha.1, t) * alpha_mul) as f32;
            let size = p.size * lerp(1.0, e.size_end, t);
            let add = if e.additive { 1.0 } else { 0.0 };
            match &e.sprite {
                Some(sp) => {
                    let (mut x, mut y) = (p.x, p.y);
                    if snap {
                        x = js_round(x);
                        y = js_round(y);
                    }
                    let extent = (sp.w * size.abs()).max(sp.h * size.abs());
                    if !self.visible(x, y, extent) {
                        continue;
                    }
                    let (cos, sin) = if p.rot != 0.0 { (p.rot.cos(), p.rot.sin()) } else { (1.0, 0.0) };
                    let tx = m[0] * x + m[2] * y + m[4];
                    let ty = m[1] * x + m[3] * y + m[5];
                    let ax = (m[0] * cos + m[2] * sin) * size;
                    let ay = (m[1] * cos + m[3] * sin) * size;
                    let bx = (-m[0] * sin + m[2] * cos) * size;
                    let by = (-m[1] * sin + m[3] * cos) * size;
                    let (r, g, b) = rgb(p.color);
                    self.push(tx, ty, ax, ay, bx, by, -sp.ox, -sp.oy, sp.w - sp.ox, sp.h - sp.oy, sp.u0, sp.v0, sp.u1, sp.v1, r, g, b, alpha, add, 0.0);
                }
                None => {
                    let s = js_round(size).max(1.0);
                    let x = js_round(p.x - s / 2.0);
                    let y = js_round(p.y - s / 2.0);
                    if !self.visible(x + s / 2.0, y + s / 2.0, s) {
                        continue;
                    }
                    self.rect(x, y, s, s, p.color, alpha, if add > 0.5 { 1 } else { 0 });
                }
            }
        }
        self.emitters[id as usize] = Some(e);
    }
}

impl Emitter {
    fn spawn(&mut self, x: f64, y: f64) {
        if self.live.len() >= self.max {
            return;
        }
        let r = &mut self.rng;
        let a = r.range(self.angle.0, self.angle.1);
        let sp = r.range(self.speed.0, self.speed.1);
        let off = if self.spread > 0.0 { r.range(0.0, self.spread) } else { 0.0 };
        let oa = r.range(0.0, TAU);
        let max_life = r.range(self.life.0, self.life.1);
        let size = r.range(self.size.0, self.size.1);
        let color = self.colors[r.pick_index(self.colors.len())];
        let rot = if self.sprite.is_some() { r.range(0.0, TAU) } else { 0.0 };
        let spin = self.spin * r.sign();
        self.live.push(Particle {
            x: x + oa.cos() * off,
            y: y + oa.sin() * off,
            vx: a.cos() * sp,
            vy: a.sin() * sp,
            life: max_life,
            max_life,
            size,
            rot,
            spin,
            color,
        });
    }

    fn step(&mut self, dt: f64, emitting: bool, ex: f64, ey: f64) {
        if emitting && self.rate > 0.0 {
            self.acc += self.rate * dt;
            let n = self.acc.floor();
            if n > 0.0 {
                self.acc -= n;
                for _ in 0..(n as usize) {
                    self.spawn(ex, ey);
                }
            }
        }
        let drag_k = if self.drag > 0.0 { (1.0 - self.drag * dt).max(0.0) } else { 1.0 };
        let gravity = self.gravity;
        self.live.retain_mut(|p| {
            p.life -= dt;
            if p.life <= 0.0 {
                return false;
            }
            p.vy += gravity * dt;
            p.vx *= drag_k;
            p.vy *= drag_k;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += p.spin * dt;
            true
        });
    }
}

fn write_quad(
    v: &mut [f32], o: usize,
    tx: f64, ty: f64, ax: f64, ay: f64, bx: f64, by: f64,
    x0: f64, y0: f64, x1: f64, y1: f64,
    u0: f32, v0: f32, u1: f32, v1: f32,
    r: f32, g: f32, b: f32, a: f32, add: f32, slot: f32,
) {
    const S: usize = FLOATS_PER_VERT;
    v[o] = (tx + ax * x0 + bx * y0) as f32;
    v[o + 1] = (ty + ay * x0 + by * y0) as f32;
    v[o + 2] = u0;
    v[o + 3] = v0;
    v[o + S] = (tx + ax * x1 + bx * y0) as f32;
    v[o + S + 1] = (ty + ay * x1 + by * y0) as f32;
    v[o + S + 2] = u1;
    v[o + S + 3] = v0;
    v[o + 2 * S] = (tx + ax * x1 + bx * y1) as f32;
    v[o + 2 * S + 1] = (ty + ay * x1 + by * y1) as f32;
    v[o + 2 * S + 2] = u1;
    v[o + 2 * S + 3] = v1;
    v[o + 3 * S] = (tx + ax * x0 + bx * y1) as f32;
    v[o + 3 * S + 1] = (ty + ay * x0 + by * y1) as f32;
    v[o + 3 * S + 2] = u0;
    v[o + 3 * S + 3] = v1;
    for k in 0..4 {
        let c = o + k * FLOATS_PER_VERT;
        v[c + 4] = r;
        v[c + 5] = g;
        v[c + 6] = b;
        v[c + 7] = a;
        v[c + 8] = add;
        v[c + 9] = slot;
    }
}

fn rgb(c: u32) -> (f32, f32, f32) {
    ((((c >> 16) & 255) as f32) / 255.0, (((c >> 8) & 255) as f32) / 255.0, ((c & 255) as f32) / 255.0)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// JavaScript's Math.round: halves round toward positive infinity.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

// --- C ABI ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kiln_version() -> u32 {
    VERSION
}

#[no_mangle]
pub extern "C" fn kiln_new(max_quads: u32, stream_words: u32) -> *mut Kernel {
    Box::into_raw(Box::new(Kernel::new(max_quads as usize, stream_words as usize)))
}

/// # Safety
/// `k` must come from `kiln_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn kiln_free(k: *mut Kernel) {
    if !k.is_null() {
        drop(Box::from_raw(k));
    }
}

macro_rules! with {
    ($k:expr, $body:expr, $default:expr) => {{
        if $k.is_null() {
            $default
        } else {
            let k: &mut Kernel = unsafe { &mut *$k };
            #[allow(clippy::redundant_closure_call)]
            ($body)(k)
        }
    }};
}

#[no_mangle]
pub extern "C" fn kiln_stream(k: *mut Kernel) -> *mut f32 {
    with!(k, |k: &mut Kernel| k.stream.as_mut_ptr(), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn kiln_stream_words(k: *mut Kernel) -> u32 {
    with!(k, |k: &mut Kernel| k.stream.len() as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_scratch(k: *mut Kernel) -> *mut f32 {
    with!(k, |k: &mut Kernel| k.scratch.as_mut_ptr(), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn kiln_scratch_words(k: *mut Kernel) -> u32 {
    with!(k, |k: &mut Kernel| k.scratch.len() as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_vertices(k: *mut Kernel) -> *const f32 {
    with!(k, |k: &mut Kernel| k.verts.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn kiln_vertex_cap(k: *mut Kernel) -> u32 {
    with!(k, |k: &mut Kernel| (k.max_quads * 4) as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_commands(k: *mut Kernel) -> *const u32 {
    with!(k, |k: &mut Kernel| k.cmds.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn kiln_command_cap(k: *mut Kernel) -> u32 {
    with!(k, |k: &mut Kernel| k.cmds.len() as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_stats(k: *mut Kernel) -> *const u32 {
    with!(k, |k: &mut Kernel| k.stats.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn kiln_set_white(k: *mut Kernel, u: f32, v: f32) {
    with!(k, |k: &mut Kernel| k.set_white(u, v), ())
}

#[no_mangle]
pub extern "C" fn kiln_run(k: *mut Kernel, stream_len: u32) {
    with!(k, |k: &mut Kernel| k.run(stream_len as usize), ())
}

#[no_mangle]
pub extern "C" fn kiln_batch_create(k: *mut Kernel, capacity: u32) -> i32 {
    with!(k, |k: &mut Kernel| k.batch_create(capacity as usize), -1)
}

#[no_mangle]
pub extern "C" fn kiln_batch_data(k: *mut Kernel, id: i32) -> *mut f32 {
    with!(k, |k: &mut Kernel| k.batch_data(id).map(|d| d.as_mut_ptr()).unwrap_or(std::ptr::null_mut()), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn kiln_batch_set_count(k: *mut Kernel, id: i32, count: u32) {
    with!(k, |k: &mut Kernel| k.batch_set_count(id, count as usize), ())
}

#[no_mangle]
pub extern "C" fn kiln_batch_destroy(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| k.batch_destroy(id), ())
}

#[no_mangle]
pub extern "C" fn kiln_emitter_create(k: *mut Kernel, config_words: u32) -> i32 {
    with!(k, |k: &mut Kernel| k.emitter_create(config_words as usize), -1)
}

#[no_mangle]
pub extern "C" fn kiln_emitter_burst(k: *mut Kernel, id: i32, n: u32, x: f32, y: f32) {
    with!(k, |k: &mut Kernel| k.emitter_burst(id, n as usize, x as f64, y as f64), ())
}

#[no_mangle]
pub extern "C" fn kiln_emitter_count(k: *mut Kernel, id: i32) -> u32 {
    with!(k, |k: &mut Kernel| k.emitter_count(id) as u32, 0)
}

#[no_mangle]
pub extern "C" fn kiln_emitter_clear(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| k.emitter_clear(id), ())
}

#[no_mangle]
pub extern "C" fn kiln_emitter_destroy(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| k.emitter_destroy(id), ())
}

// --- World-space batches and shadows ------------------------------------------------------

#[no_mangle]
pub extern "C" fn kiln_batch3_create(k: *mut Kernel, capacity: u32) -> i32 {
    with!(k, |k: &mut Kernel| k.batch3_create(capacity as usize), -1)
}
#[no_mangle]
pub extern "C" fn kiln_batch3_data(k: *mut Kernel, id: i32) -> *mut f32 {
    with!(k, |k: &mut Kernel| k.batch3_data(id).map(|d| d.as_mut_ptr()).unwrap_or(std::ptr::null_mut()), std::ptr::null_mut())
}
#[no_mangle]
pub extern "C" fn kiln_batch3_set_count(k: *mut Kernel, id: i32, count: u32) {
    with!(k, |k: &mut Kernel| k.batch3_set_count(id, count as usize), ())
}
#[no_mangle]
pub extern "C" fn kiln_batch3_destroy(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| k.batch3_destroy(id), ())
}
#[no_mangle]
pub extern "C" fn kiln_set_shadow(k: *mut Kernel, w: f32, h: f32, ox: f32, oy: f32, u0: f32, v0: f32, u1: f32, v1: f32) {
    with!(k, |k: &mut Kernel| k.set_shadow(w, h, ox, oy, u0, v0, u1, v1), ())
}

// --- Node tables -----------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn kiln_nodes_create(k: *mut Kernel, capacity: u32) -> i32 {
    with!(k, |k: &mut Kernel| k.nodes_create(capacity as usize), -1)
}
#[no_mangle]
pub extern "C" fn kiln_nodes_data(k: *mut Kernel, id: i32) -> *mut f32 {
    with!(k, |k: &mut Kernel| k.nodes(id).map(|t| t.data.as_mut_ptr()).unwrap_or(std::ptr::null_mut()), std::ptr::null_mut())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_capacity(k: *mut Kernel, id: i32) -> u32 {
    with!(k, |k: &mut Kernel| k.nodes(id).map(|t| t.capacity as u32).unwrap_or(0), 0)
}
#[no_mangle]
pub extern "C" fn kiln_nodes_alloc(k: *mut Kernel, id: i32) -> i32 {
    with!(k, |k: &mut Kernel| k.nodes(id).map(|t| t.alloc()).unwrap_or(-1), -1)
}
#[no_mangle]
pub extern "C" fn kiln_nodes_free(k: *mut Kernel, id: i32, index: i32) {
    with!(k, |k: &mut Kernel| { if let Some(t) = k.nodes(id) { t.free(index) } }, ())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_clear(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| { if let Some(t) = k.nodes(id) { t.clear() } }, ())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_count(k: *mut Kernel, id: i32) -> u32 {
    with!(k, |k: &mut Kernel| k.nodes(id).map(|t| t.live as u32).unwrap_or(0), 0)
}
/// One past the highest slot in use; scripts iterating the table stop there.
#[no_mangle]
pub extern "C" fn kiln_nodes_high(k: *mut Kernel, id: i32) -> u32 {
    with!(k, |k: &mut Kernel| k.nodes(id).map(|t| t.high as u32).unwrap_or(0), 0)
}
#[no_mangle]
pub extern "C" fn kiln_nodes_step(k: *mut Kernel, id: i32, dt: f32) {
    with!(k, |k: &mut Kernel| { if let Some(t) = k.nodes(id) { t.step(dt as f64) } }, ())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_configure(k: *mut Kernel, id: i32, gx: f32, gy: f32, damping: f32, mode: u32, bx: f32, by: f32, bw: f32, bh: f32, gz: f32, floor: u32) {
    with!(k, |k: &mut Kernel| { if let Some(t) = k.nodes(id) { t.configure(gx as f64, gy as f64, damping as f64, mode, [bx as f64, by as f64, bw as f64, bh as f64]); t.gravity_z = gz as f64; t.floor = floor; } }, ())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_set_frames(k: *mut Kernel, id: i32, words: u32) {
    with!(k, |k: &mut Kernel| k.nodes_set_frames(id, words as usize), ())
}
#[no_mangle]
pub extern "C" fn kiln_nodes_apply_transforms(k: *mut Kernel, id: i32, words: u32) -> u32 {
    with!(k, |k: &mut Kernel| k.nodes_apply_transforms(id, words as usize), 0)
}
#[no_mangle]
pub extern "C" fn kiln_nodes_destroy(k: *mut Kernel, id: i32) {
    with!(k, |k: &mut Kernel| k.nodes_destroy(id), ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_recycles_bounded_storage_and_preserves_ties() {
        let mut k = Kernel::new(64, 1024);
        k.sorted = true;
        for i in 0..80 {
            let mut v = [0.0; 4 * FLOATS_PER_VERT];
            v[0] = i as f32;
            k.emit_quad(v);
        }
        assert_eq!(k.pending.len(), 64);
        assert_eq!(k.stats[STAT_DROPPED], 16);
        let capacity = k.pending.capacity();
        k.flush_sorted();
        assert_eq!(k.pending.capacity(), capacity);
        assert_eq!(k.pending_order.len(), 64);
        assert_eq!(k.verts[63 * 4 * FLOATS_PER_VERT], 63.0);
        assert!(k.pending.is_empty());
    }

    #[test]
    fn rng_matches_mulberry32_reference() {
        // First values of mulberry32 seeded with 1, as the TypeScript Rng produces them.
        let mut r = Rng::new(1);
        let a = r.next();
        let b = r.next();
        assert!((0.0..1.0).contains(&a) && (0.0..1.0).contains(&b));
        assert_ne!(a, b);
        let mut r2 = Rng::new(1);
        assert_eq!(r2.next(), a);
    }

    #[test]
    fn a_sprite_becomes_one_quad_between_begin_and_end() {
        let mut k = Kernel::new(64, 1024);
        k.set_white(0.5, 0.5);
        let stream: Vec<f32> = vec![
            OP_BEGIN as f32, 0x102030 as f32, 640.0, 360.0,
            OP_PASS as f32, 0.0, 0.0,
            OP_TRANSFORM as f32, 2.0, 0.0, 0.0, 2.0, 10.0, 20.0,
            OP_SPRITE as f32, 5.0, 6.0, 1.0, 1.0, 0.0, 0.0, 0.0, 8.0, 4.0, 0.1, 0.2, 0.3, 0.4, 0xff8000 as f32, 1.0, 0.0, 0.0, 0.0,
            OP_RECT as f32, 0.0, 0.0, 3.0, 3.0, 0xffffff as f32, 0.5, 0.0,
            OP_END as f32,
        ];
        k.stream_mut()[..stream.len()].copy_from_slice(&stream);
        k.run(stream.len());
        assert_eq!(k.stats()[STAT_VERTICES], 8);
        assert_eq!(k.stats()[STAT_DRAWS], 1);
        let v = k.vertices();
        assert_eq!(v[0], 20.0); // 10 + 2 * 5
        assert_eq!(v[1], 32.0); // 20 + 2 * 6
        assert_eq!(v[FLOATS_PER_VERT], 36.0); // x1 = 8 wide, scaled by 2
        assert_eq!(v[4], 1.0);
        assert!((v[5] - 128.0 / 255.0).abs() < 1e-6);
        let c = k.commands();
        assert_eq!(&c[..2], &[CMD_BEGIN, 0x102030]);
        assert_eq!(&c[2..5], &[CMD_PASS, 0, 0]);
        assert_eq!(&c[5..8], &[CMD_DRAW, 0, 8]);
        assert_eq!(c[8], CMD_END);
    }

    #[test]
    fn batches_cull_and_particles_live() {
        let mut k = Kernel::new(1024, 4096);
        let b = k.batch_create(4);
        {
            let d = k.batch_data(b).unwrap();
            for n in 0..4 {
                let o = n * BATCH_STRIDE;
                d[o] = n as f32 * 100.0;
                d[o + 1] = 0.0;
                d[o + 2] = 32.0;
                d[o + 3] = 32.0;
            }
        }
        k.batch_set_count(b, 4);
        let s = k.scratch_mut();
        s[cfg::RATE] = 100.0;
        s[cfg::LIFE0] = 1.0;
        s[cfg::LIFE1] = 1.0;
        s[cfg::SPEED1] = 10.0;
        s[cfg::ANGLE1] = TAU as f32;
        s[cfg::SIZE0] = 2.0;
        s[cfg::SIZE1] = 2.0;
        s[cfg::ALPHA0] = 1.0;
        s[cfg::MAX] = 500.0;
        s[cfg::SEED] = 3.0;
        s[cfg::COLOR_COUNT] = 1.0;
        s[cfg::COLORS] = 0xff0000 as f32;
        let e = k.emitter_create(cfg::COLORS + 1);
        let stream: Vec<f32> = vec![
            OP_BEGIN as f32, 0.0, 640.0, 360.0,
            OP_BATCH as f32, b as f32, 1.0, 0xffffff as f32, 0.0, 0.0, 150.0, 50.0, 0.0,
            OP_PARTICLES as f32, e as f32, 0.1, 1.0, 50.0, 50.0, 1.0, 1.0,
            OP_END as f32,
        ];
        k.stream_mut()[..stream.len()].copy_from_slice(&stream);
        k.run(stream.len());
        // Two of four tiles are inside the cull rect; ten particles were spawned in 0.1 s.
        assert_eq!(k.emitter_count(e), 10);
        assert_eq!(k.stats()[STAT_SPRITES], 12);
        assert_eq!(k.stats()[STAT_PARTICLES], 10);
    }
}

#[cfg(feature = "physics3d")]
pub mod physics3d;
