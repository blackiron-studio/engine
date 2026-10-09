//! The retained node table: sprites whose state lives in the kernel. A game allocates a
//! slot, writes position, velocity, sprite and look once, and from then on the kernel moves,
//! animates, culls and draws it every frame with no script work per node. Thousands of
//! moving sprites cost the script nothing; a node bound to a physics body follows it.
//!
//! Each node is `NODE_WORDS` f32 words in one flat buffer the script can view directly
//! (Wasm and JavaScriptCore) or mirror (copying hosts). Colours are 24-bit integers, exact
//! in an f32.

pub const NODE_WORDS: usize = 32;

/// Word offsets inside a node record.
pub mod n {
    pub const X: usize = 0;
    pub const Y: usize = 1;
    pub const ROT: usize = 2;
    pub const SX: usize = 3;
    pub const SY: usize = 4;
    pub const VX: usize = 5;
    pub const VY: usize = 6;
    pub const VROT: usize = 7;
    pub const W: usize = 8;
    pub const H: usize = 9;
    pub const OX: usize = 10;
    pub const OY: usize = 11;
    pub const U0: usize = 12;
    pub const V0: usize = 13;
    pub const U1: usize = 14;
    pub const V1: usize = 15;
    pub const TINT: usize = 16;
    pub const ALPHA: usize = 17;
    pub const FLAGS: usize = 18;
    /// Seconds left when FLAG_EXPIRES is set; the node frees itself at zero.
    pub const LIFE: usize = 19;
    /// Fractional frame index into the table's frame list, from FRAME_BASE.
    pub const FRAME: usize = 20;
    pub const FRAME_COUNT: usize = 21;
    pub const FPS: usize = 22;
    pub const FRAME_BASE: usize = 23;
    /// Physics body id the node follows, or -1.
    pub const BODY: usize = 24;
    /// Free for the game.
    pub const USER: usize = 25;
    /// Height above the ground, in world units.
    pub const Z: usize = 26;
    pub const VZ: usize = 27;
    /// Added to the depth key under a projection.
    pub const DEPTH_BIAS: usize = 28;
}

pub const FLAG_ALIVE: u32 = 1;
pub const FLAG_ADDITIVE: u32 = 2;
pub const FLAG_SMOOTH: u32 = 4;
pub const FLAG_HIDDEN: u32 = 8;
pub const FLAG_FLIP_X: u32 = 16;
pub const FLAG_FLIP_Y: u32 = 32;
pub const FLAG_EXPIRES: u32 = 64;
/// Draw a blob shadow on the ground under the node (projected layers).
pub const FLAG_SHADOW: u32 = 128;

pub const FLOOR_NONE: u32 = 0;
/// Stop at z = 0.
pub const FLOOR_STOP: u32 = 1;
/// Bounce at z = 0, losing some speed each time.
pub const FLOOR_BOUNCE: u32 = 2;

pub const BOUNDS_NONE: u32 = 0;
pub const BOUNDS_WRAP: u32 = 1;
pub const BOUNDS_BOUNCE: u32 = 2;
pub const BOUNDS_KILL: u32 = 3;

/// One frame of a table's frame list: a sprite region, 8 words in the scratch buffer.
#[derive(Clone, Copy, Default)]
pub struct Frame {
    pub w: f32,
    pub h: f32,
    pub ox: f32,
    pub oy: f32,
    pub u0: f32,
    pub v0: f32,
    pub u1: f32,
    pub v1: f32,
}

pub const FRAME_WORDS: usize = 8;

pub struct NodeTable {
    pub data: Vec<f32>,
    pub capacity: usize,
    free: Vec<u32>,
    /// One past the highest slot ever allocated, so iteration skips the never-used tail.
    pub high: usize,
    pub live: usize,
    pub gravity: (f64, f64),
    pub damping: f64,
    pub bounds_mode: u32,
    pub bounds: [f64; 4],
    pub frames: Vec<Frame>,
    pub gravity_z: f64,
    pub floor: u32,
}

impl NodeTable {
    pub fn new(capacity: usize) -> NodeTable {
        let capacity = capacity.max(1);
        NodeTable {
            data: vec![0.0; capacity * NODE_WORDS],
            capacity,
            free: (0..capacity as u32).rev().collect(),
            high: 0,
            live: 0,
            gravity: (0.0, 0.0),
            damping: 0.0,
            bounds_mode: BOUNDS_NONE,
            bounds: [0.0; 4],
            frames: Vec::new(),
            gravity_z: 0.0,
            floor: FLOOR_NONE,
        }
    }

    /// Take a free slot, zero it, mark it alive with unit scale and full alpha. -1 when full.
    pub fn alloc(&mut self) -> i32 {
        let Some(i) = self.free.pop() else { return -1 };
        let o = i as usize * NODE_WORDS;
        for w in &mut self.data[o..o + NODE_WORDS] {
            *w = 0.0;
        }
        self.data[o + n::SX] = 1.0;
        self.data[o + n::SY] = 1.0;
        self.data[o + n::TINT] = 0xff_ffff as f32;
        self.data[o + n::ALPHA] = 1.0;
        self.data[o + n::FLAGS] = FLAG_ALIVE as f32;
        self.data[o + n::BODY] = -1.0;
        self.live += 1;
        self.high = self.high.max(i as usize + 1);
        i as i32
    }

    pub fn free(&mut self, index: i32) {
        if index < 0 || index as usize >= self.capacity {
            return;
        }
        let o = index as usize * NODE_WORDS;
        if (self.data[o + n::FLAGS] as u32) & FLAG_ALIVE == 0 {
            return;
        }
        self.data[o + n::FLAGS] = 0.0;
        self.free.push(index as u32);
        self.live -= 1;
    }

    pub fn clear(&mut self) {
        for i in 0..self.high {
            let o = i * NODE_WORDS;
            self.data[o + n::FLAGS] = 0.0;
        }
        self.free = (0..self.capacity as u32).rev().collect();
        self.live = 0;
        self.high = 0;
    }

    pub fn configure(&mut self, gx: f64, gy: f64, damping: f64, mode: u32, bounds: [f64; 4]) {
        self.gravity = (gx, gy);
        self.damping = damping;
        self.bounds_mode = mode;
        self.bounds = bounds;
    }

    /// Replace the frame list from `words` scratch floats, 8 per frame.
    pub fn set_frames(&mut self, scratch: &[f32]) {
        self.frames.clear();
        for f in scratch.chunks_exact(FRAME_WORDS) {
            self.frames.push(Frame { w: f[0], h: f[1], ox: f[2], oy: f[3], u0: f[4], v0: f[5], u1: f[6], v1: f[7] });
        }
    }

    /// Integrate velocities, age lifetimes, advance animations and apply the bounds rule.
    pub fn step(&mut self, dt: f64) {
        let (gx, gy) = self.gravity;
        let damp = if self.damping > 0.0 { (1.0 - self.damping * dt).max(0.0) } else { 1.0 };
        let mode = self.bounds_mode;
        let [bx, by, bw, bh] = self.bounds;
        let gz_grav = self.gravity_z;
        let floor = self.floor;
        let mut to_free: Vec<u32> = Vec::new();
        for i in 0..self.high {
            let o = i * NODE_WORDS;
            let d = &mut self.data[o..o + NODE_WORDS];
            let flags = d[n::FLAGS] as u32;
            if flags & FLAG_ALIVE == 0 {
                continue;
            }
            if flags & FLAG_EXPIRES != 0 {
                let life = d[n::LIFE] as f64 - dt;
                d[n::LIFE] = life as f32;
                if life <= 0.0 {
                    to_free.push(i as u32);
                    continue;
                }
            }
            let mut vx = d[n::VX] as f64 + gx * dt;
            let mut vy = d[n::VY] as f64 + gy * dt;
            vx *= damp;
            vy *= damp;
            let mut x = d[n::X] as f64 + vx * dt;
            let mut y = d[n::Y] as f64 + vy * dt;
            d[n::ROT] = (d[n::ROT] as f64 + d[n::VROT] as f64 * dt) as f32;
            match mode {
                BOUNDS_WRAP if bw > 0.0 && bh > 0.0 => {
                    if x < bx { x += bw; } else if x >= bx + bw { x -= bw; }
                    if y < by { y += bh; } else if y >= by + bh { y -= bh; }
                }
                BOUNDS_BOUNCE if bw > 0.0 && bh > 0.0 => {
                    if x < bx { x = bx; vx = vx.abs(); } else if x > bx + bw { x = bx + bw; vx = -vx.abs(); }
                    if y < by { y = by; vy = vy.abs(); } else if y > by + bh { y = by + bh; vy = -vy.abs(); }
                }
                BOUNDS_KILL if bw > 0.0 && bh > 0.0 => {
                    if x < bx || x > bx + bw || y < by || y > by + bh {
                        to_free.push(i as u32);
                        continue;
                    }
                }
                _ => {}
            }
            d[n::X] = x as f32;
            d[n::Y] = y as f32;
            d[n::VX] = vx as f32;
            d[n::VY] = vy as f32;
            // Height: its own velocity and gravity, with a floor at zero.
            let mut vz = d[n::VZ] as f64 + gz_grav * dt;
            let mut z = d[n::Z] as f64 + vz * dt;
            if z < 0.0 && floor != FLOOR_NONE {
                z = 0.0;
                vz = if floor == FLOOR_BOUNCE && vz < -30.0 { -vz * 0.55 } else { 0.0 };
            }
            d[n::Z] = z as f32;
            d[n::VZ] = vz as f32;
            let count = d[n::FRAME_COUNT] as f64;
            let fps = d[n::FPS] as f64;
            if count > 1.0 && fps != 0.0 {
                let mut f = d[n::FRAME] as f64 + fps * dt;
                f %= count;
                if f < 0.0 {
                    f += count;
                }
                d[n::FRAME] = f as f32;
            }
        }
        for i in to_free {
            self.free(i as i32);
        }
    }

    /// Copy positions from physics transforms (8 words per body: id, x, y, rot, ...) into the
    /// nodes bound to those bodies. Returns how many nodes moved.
    pub fn apply_transforms(&mut self, transforms: &[f32]) -> u32 {
        let bodies = transforms.len() / 8;
        if bodies == 0 {
            return 0;
        }
        // Body ids are small integers; a direct index beats a hash map here.
        let max_id = transforms.chunks_exact(8).map(|t| t[0].max(0.0) as usize).max().unwrap_or(0);
        let mut by_id: Vec<i32> = vec![-1; max_id + 1];
        for (k, t) in transforms.chunks_exact(8).enumerate() {
            if t[0] >= 0.0 {
                by_id[t[0] as usize] = k as i32;
            }
        }
        let mut moved = 0;
        for i in 0..self.high {
            let o = i * NODE_WORDS;
            let d = &mut self.data[o..o + NODE_WORDS];
            if (d[n::FLAGS] as u32) & FLAG_ALIVE == 0 || d[n::BODY] < 0.0 {
                continue;
            }
            let id = d[n::BODY] as usize;
            let Some(&k) = by_id.get(id) else { continue };
            if k < 0 {
                continue;
            }
            let t = &transforms[k as usize * 8..k as usize * 8 + 8];
            d[n::X] = t[1];
            d[n::Y] = t[2];
            d[n::ROT] = t[3];
            d[n::VX] = t[4];
            d[n::VY] = t[5];
            d[n::VROT] = t[6];
            moved += 1;
        }
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_free_and_reuse() {
        let mut t = NodeTable::new(3);
        assert_eq!((t.alloc(), t.alloc(), t.alloc(), t.alloc()), (0, 1, 2, -1));
        assert_eq!(t.live, 3);
        t.free(1);
        t.free(1);
        assert_eq!(t.live, 2);
        assert_eq!(t.alloc(), 1);
        assert_eq!(t.high, 3);
        let o = NODE_WORDS;
        assert_eq!((t.data[o + n::SX], t.data[o + n::ALPHA], t.data[o + n::BODY]), (1.0, 1.0, -1.0));
        t.clear();
        assert_eq!((t.live, t.high), (0, 0));
    }

    #[test]
    fn step_moves_bounces_expires_and_animates() {
        let mut t = NodeTable::new(4);
        t.configure(0.0, 100.0, 0.0, BOUNDS_BOUNCE, [0.0, 0.0, 100.0, 100.0]);
        let a = t.alloc() as usize * NODE_WORDS;
        t.data[a + n::X] = 99.0;
        t.data[a + n::VX] = 120.0;
        t.data[a + n::FRAME_COUNT] = 4.0;
        t.data[a + n::FPS] = 30.0;
        let b = t.alloc() as usize * NODE_WORDS;
        t.data[b + n::LIFE] = 0.05;
        t.data[b + n::FLAGS] = (FLAG_ALIVE | FLAG_EXPIRES) as f32;
        t.step(0.1);
        assert_eq!(t.data[a + n::X], 100.0);
        assert_eq!(t.data[a + n::VX], -120.0);
        assert!((t.data[a + n::VY] - 10.0).abs() < 1e-5);
        assert!((t.data[a + n::FRAME] - 3.0).abs() < 1e-5);
        assert_eq!(t.live, 1);
    }

    #[test]
    fn transforms_reach_bound_nodes_only() {
        let mut t = NodeTable::new(4);
        let a = t.alloc() as usize * NODE_WORDS;
        let free = t.alloc() as usize * NODE_WORDS;
        t.data[a + n::BODY] = 7.0;
        let moved = t.apply_transforms(&[2.0, 11.0, 22.0, 0.5, 1.0, 2.0, 3.0, 0.0, 7.0, 44.0, 55.0, -0.25, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(moved, 1);
        assert_eq!((t.data[a + n::X], t.data[a + n::Y], t.data[a + n::ROT]), (44.0, 55.0, -0.25));
        assert_eq!(t.data[free + n::X], 0.0);
    }
}
