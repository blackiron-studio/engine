//! The JavaScript side: a script engine running the game bundle, the `__blackironHost` object the
//! engine's NativePlatform and NativeRenderer call, timers, and the `__blackiron` bridge the host
//! drives every frame. The kernel and the synthesiser are Rust objects owned here; the script
//! reaches them through small copying wrappers registered as engine-neutral natives (see
//! `script/`), so QuickJS and V8 are interchangeable.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use blackiron_kernel::audio::Audio;
use blackiron_kernel::nodes::NODE_WORDS;
use blackiron_kernel::physics::Physics;
use blackiron_kernel::Kernel;

use crate::bundle::Bundle;
use crate::script::{arg, Engine, EngineKind, Val};
use crate::storage::Storage;
use crate::text::TextSystem;

#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub insets: [f64; 4],
}

pub struct TextureUpload {
    pub slot: usize,
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

pub struct FrameOut {
    pub post: Vec<f32>,
    pub vertex_count: usize,
    pub command_count: usize,
}

pub struct HostState {
    pub kernel: Kernel,
    pub audio: Option<Arc<Mutex<Audio>>>,
    pub audio_rate: u32,
    pub bundle: Bundle,
    pub storage: Storage,
    pub text: TextSystem,
    pub uploads: Vec<TextureUpload>,
    pub frame: Option<FrameOut>,
    pub mesh_packet: Option<String>,
    pub boot_failed: bool,
    pub mesh_resources: (usize, usize, usize),
    pub haptics: Vec<String>,
    /// Text the script asked the screen reader to say.
    pub announcements: Vec<String>,
    pub physics: Vec<Option<Physics>>,
    /// Set by the script when a text field wants the on-screen keyboard.
    pub keyboard: Option<bool>,
    pub pointer_capture: Option<bool>,
    /// A synthetic clock in milliseconds for reproducible runs; None means wall time.
    pub clock: Option<f64>,
    start: Instant,
}

impl HostState {
    fn now(&self) -> f64 {
        self.clock.unwrap_or_else(|| self.start.elapsed().as_secs_f64() * 1000.0)
    }
}

pub struct Js {
    engine: Box<dyn Engine>,
    pub state: Rc<RefCell<HostState>>,
}

const GLUE: &str = r#"
(() => {
  const timers = new Map();
  let next = 1;
  const now = () => globalThis.__blackironHost.now();
  globalThis.setTimeout = (cb, ms = 0, ...args) => { const id = next++; timers.set(id, { cb, due: now() + Math.max(0, +ms || 0), interval: 0, args }); return id; };
  globalThis.setInterval = (cb, ms = 0, ...args) => { const id = next++; const iv = Math.max(1, +ms || 0); timers.set(id, { cb, due: now() + iv, interval: iv, args }); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.clearInterval = globalThis.clearTimeout;
  globalThis.__blackironRunTimers = (t) => {
    for (const [id, timer] of [...timers]) {
      if (timer.due > t) continue;
      if (timer.interval) timer.due = t + timer.interval; else timers.delete(id);
      try { timer.cb(...timer.args); } catch (e) { console.error(e && e.stack || e); }
    }
  };
})();
(() => {
  const K = globalThis.__blackironKernelNative, A = globalThis.__blackironAudioNative, H = globalThis.__blackironHost;
  const stream = new Float32Array(K.streamWords()), scratch = new Float32Array(4096), stats = new Uint32Array(8), batches = new Map(), batches3 = new Map(), tables = new Map();
  H.kernel = {
    kind: "native", maxQuads: K.maxQuads(), stream, scratch, vertices: new Float32Array(0), commands: new Uint32Array(0), stats,
    setWhite: (u, v) => K.setWhite(u, v),
    run: (len) => { const s = K.run(stream.subarray(0, len), len); for (let i = 0; i < 8; i++) stats[i] = s[i]; },
    createBatch: (cap) => { const id = K.createBatch(cap); batches.set(id, new Float32Array(Math.max(1, cap) * 8)); return id; },
    batchData: (id) => batches.get(id) ?? new Float32Array(0),
    setBatchCount: (id, n) => { const d = batches.get(id); if (d) K.setBatchData(id, d.subarray(0, n * 8), n); },
    destroyBatch: (id) => { batches.delete(id); K.destroyBatch(id); },
    createEmitter: (words) => K.createEmitter(scratch.subarray(0, words), words),
    burst: (id, n, x, y) => K.burst(id, n, x, y),
    emitterCount: (id) => K.emitterCount(id),
    clearEmitter: (id) => K.clearEmitter(id),
    destroyEmitter: (id) => K.destroyEmitter(id),
    createNodes: (cap) => { const id = K.createNodes(cap); tables.set(id, new Float32Array(Math.max(1, cap) * 32)); return id; },
    nodesData: (id) => tables.get(id) ?? new Float32Array(0),
    allocNode: (id) => { const i = K.allocNode(id); const d = tables.get(id); if (d && i >= 0) { const o = i * 32; d.fill(0, o, o + 32); d[o + 3] = 1; d[o + 4] = 1; d[o + 16] = 0xffffff; d[o + 17] = 1; d[o + 18] = 1; d[o + 24] = -1; } return i; },
    freeNode: (id, i) => { K.freeNode(id, i); const d = tables.get(id); if (d && i >= 0) d[i * 32 + 18] = 0; },
    clearNodes: (id) => { K.clearNodes(id); tables.get(id)?.fill(0); },
    nodeCount: (id) => K.nodeCount(id),
    nodesHigh: (id) => K.nodesHigh(id),
    stepNodes: (id, dt) => K.stepNodes(id, dt),
    configureNodes: (id, gx, gy, damping, mode, bx, by, bw, bh, gz = 0, floor = 0) => K.configureNodes(id, [gx, gy, damping, mode, bx, by, bw, bh, gz, floor]),
    createBatch3: (cap) => { const id = K.createBatch3(cap); batches3.set(id, new Float32Array(Math.max(1, cap) * 14)); return id; },
    batch3Data: (id) => batches3.get(id) ?? new Float32Array(0),
    setBatch3Count: (id, n) => { const d = batches3.get(id); if (d) K.setBatch3Data(id, d.subarray(0, n * 14), n); },
    destroyBatch3: (id) => { batches3.delete(id); K.destroyBatch3(id); },
    setShadow: (w, h, ox, oy, u0, v0, u1, v1) => K.setShadow(w, h, ox, oy, u0, v0, u1, v1),
    setNodeFrames: (id, words) => K.setNodeFrames(id, scratch.subarray(0, words), words),
    applyNodeTransforms: (id, words) => K.applyNodeTransforms(id, scratch.subarray(0, words), words),
    destroyNodes: (id) => { tables.delete(id); K.destroyNodes(id); },
    flushNodes: (id, from, to) => { const d = tables.get(id); if (d) K.setNodesData(id, d.subarray(from * 32, to * 32), from, to); },
    pullNodes: (id) => { const d = tables.get(id); if (d) { const back = K.nodesData(id); d.set(back.subarray(0, Math.min(back.length, d.length))); } },
    destroy: () => {},
  };
  if (A.available()) {
    const ascratch = new Float32Array(8192);
    H.audio = { scratch: ascratch, unlock: () => A.unlock(), time: () => A.time(), command: (n) => A.command(ascratch.subarray(0, n), n), loadSample: (id, bytes) => A.loadSample(id, bytes), loadStream: (id, bytes) => A.loadStream(id, bytes), closeStream: (id) => A.closeStream(id), peak: () => A.peak() };
  }
  const P = globalThis.__blackironPhysicsNative;
  H.createPhysics = (ppm) => {
    const id = P.create(ppm);
    const scratch = new Float32Array(4096);
    return {
      scratch,
      call: (op, words) => { const r = P.call(id, op, scratch.subarray(0, words), words); const back = P.results(id); scratch.set(back.subarray(0, Math.min(back.length, scratch.length))); return r; },
      transforms: () => P.transforms(id),
      events: () => P.events(id),
      destroy: () => P.destroy(id),
    };
  };
  H.showKeyboard = (v) => globalThis.__blackironKeyboard(!!v);
})();
"#;

/// Copy the first `n` floats of `src` into `dst`.
fn copy_into(dst: &mut [f32], src: &[f32], n: usize) -> usize {
    let n = n.min(src.len()).min(dst.len());
    dst[..n].copy_from_slice(&src[..n]);
    n
}

impl Js {
    pub fn new(kind: EngineKind, bundle: Bundle, storage: Storage, text: TextSystem, audio: Option<Arc<Mutex<Audio>>>, audio_rate: u32, screen: Screen, max_quads: usize, stream_words: usize, deterministic: bool) -> Js {
        let mut engine = crate::script::create(kind);
        let state = Rc::new(RefCell::new(HostState {
            kernel: Kernel::new(max_quads, stream_words),
            audio,
            audio_rate,
            bundle,
            storage,
            text,
            uploads: Vec::new(),
            mesh_packet: None,
            boot_failed:false,
            mesh_resources: (0, 0, 0),
            frame: None,
            haptics: Vec::new(),
            announcements: Vec::new(),
            physics: Vec::new(),
            keyboard: None,
            pointer_capture: None,
            clock: None,
            start: Instant::now(),
        }));
        let e = &mut *engine;
        let reg = |e: &mut dyn Engine, ns: &str, name: &str, f: Box<dyn Fn(&[Val]) -> Val>| e.register(ns, name, f);

        // console
        for level in ["log", "info", "warn", "error", "debug"] {
            reg(e, "console", level, Box::new(move |args| {
                let text = args.iter().map(|a| a.text()).collect::<Vec<_>>().join(" ");
                match level {
                    "error" => log::error!("[js] {text}"),
                    "warn" => log::warn!("[js] {text}"),
                    _ => log::info!("[js] {text}"),
                }
                Val::Undefined
            }));
        }

        // host
        let st = state.clone();
        reg(e, "__blackironHost", "now", Box::new(move |_| Val::Num(st.borrow().now())));
        reg(e, "__blackironHost", "log", Box::new(|a| {
            log::info!("[blackiron:{}] {}", arg(a, 0).text(), arg(a, 1).text());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "storageGet", Box::new(move |a| st.borrow().storage.get(&arg(a, 0).text()).map(Val::Str).unwrap_or(Val::Null)));
        let st = state.clone();
        reg(e, "__blackironHost", "storageSet", Box::new(move |a| {
            match st.borrow_mut().storage.set(&arg(a, 0).text(), arg(a, 1).text()) {
                Ok(()) => Val::Bool(true),
                Err(error) => { log::error!("storage write failed: {error}"); Val::Bool(false) }
            }
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "storageRemove", Box::new(move |a| {
            match st.borrow_mut().storage.remove(&arg(a, 0).text()) {
                Ok(()) => Val::Bool(true),
                Err(error) => { log::error!("storage removal failed: {error}"); Val::Bool(false) }
            }
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "physics3D", Box::new(move |a| Val::Str(blackiron_kernel::physics3d::call(&arg(a, 0).text()))));
        reg(e, "__blackironHost", "loadBytes", Box::new(move |a| st.borrow().bundle.read(&arg(a, 0).text()).map(Val::Bytes).unwrap_or(Val::Null)));
        let st = state.clone();
        reg(e, "__blackironHost", "loadText", Box::new(move |a| st.borrow().bundle.read_text(&arg(a, 0).text()).map(Val::Str).unwrap_or(Val::Null)));
        reg(e, "__blackironHost", "decodeImage", Box::new(move |a| {
            let decoded = match arg(a, 0) { Val::Bytes(bytes) => decode_image(bytes), _ => None };
            match decoded {
                Some((w, h, rgba)) => Val::Obj(vec![("width".into(), Val::Num(w as f64)), ("height".into(), Val::Num(h as f64)), ("data".into(), Val::Bytes(rgba))]),
                None => Val::Null,
            }
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "loadImage", Box::new(move |a| {
            let bytes = st.borrow().bundle.read(&arg(a, 0).text());
            match bytes.and_then(|b| decode_image(&b)) {
                Some((w, h, rgba)) => Val::Obj(vec![("width".into(), Val::Num(w as f64)), ("height".into(), Val::Num(h as f64)), ("data".into(), Val::Bytes(rgba))]),
                None => Val::Null,
            }
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "uploadTexture", Box::new(move |a| {
            let (slot, w, h) = (arg(a, 0).int().max(0) as usize, arg(a, 1).int().max(0) as u32, arg(a, 2).int().max(0) as u32);
            if let Val::Bytes(rgba) = arg(a, 3) {
                st.borrow_mut().uploads.push(TextureUpload { slot, w, h, rgba: rgba.clone() });
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "rendererDiagnostics", Box::new(move |_| {
            let (g, t, bytes) = st.borrow().mesh_resources;
            Val::Obj(vec![("geometries".into(), Val::Num(g as f64)), ("textures".into(), Val::Num(t as f64)), ("meshBytes".into(), Val::Num(bytes as f64))])
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "submit3D", Box::new(move |a| {
            let next=arg(a,0).text();let mut state=st.borrow_mut();
            state.mesh_packet=Some(match state.mesh_packet.take(){Some(previous)=>match blackiron_kernel::render::coalesce_mesh_packets(&previous,&next){Ok(packet)=>packet,Err(error)=>{log::error!("3D pending submission: {error}");next}},None=>next});
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "submit", Box::new(move |a| {
            st.borrow_mut().frame = Some(FrameOut { post: arg(a, 0).f32s().to_vec(), vertex_count: arg(a, 1).int().max(0) as usize, command_count: arg(a, 2).int().max(0) as usize });
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "rasterizeGlyph", Box::new(move |a| {
            let Some(chr) = arg(a, 4).text().chars().next() else { return Val::Null };
            let glyph = st.borrow_mut().text.rasterize(&arg(a, 0).text(), arg(a, 1).int().max(1) as f32, arg(a, 2).int(), arg(a, 3).text() == "italic", chr);
            match glyph {
                Some(gl) => {
                    let (w, h) = (gl.w.max(1), gl.h.max(1));
                    let mut data = gl.data;
                    data.resize(w * h, 0);
                    Val::Obj(vec![
                        ("w".into(), Val::Num(w as f64)),
                        ("h".into(), Val::Num(h as f64)),
                        ("left".into(), Val::Num(gl.left as f64)),
                        ("top".into(), Val::Num(gl.top as f64)),
                        ("advance".into(), Val::Num(gl.advance as f64)),
                        ("ascent".into(), Val::Num(gl.ascent as f64)),
                        ("descent".into(), Val::Num(gl.descent as f64)),
                        ("data".into(), Val::Bytes(data)),
                    ])
                }
                None => Val::Null,
            }
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "haptic", Box::new(move |a| {
            st.borrow_mut().haptics.push(arg(a, 0).text());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironHost", "announce", Box::new(move |a| {
            st.borrow_mut().announcements.push(arg(a, 0).text());
            Val::Undefined
        }));
        let st=state.clone();
        reg(e,"__blackironHost","setPointerCapture",Box::new(move |a|{st.borrow_mut().pointer_capture=Some(arg(a,0).truthy());Val::Undefined}));
        let st=state.clone();
        reg(e,"__blackironHost","bootFailed",Box::new(move |a|{log::error!("boot failed: {}",arg(a,0).text());st.borrow_mut().boot_failed=true;Val::Undefined}));
        e.set("__blackironHost", "screen", screen_value(&screen));
        e.set("__blackironHost", "deterministic", Val::Bool(deterministic));

        // kernel
        reg(e, "__blackironKernelNative", "streamWords", Box::new(move |_| Val::Num(stream_words as f64)));
        reg(e, "__blackironKernelNative", "maxQuads", Box::new(move |_| Val::Num(max_quads as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setWhite", Box::new(move |a| {
            st.borrow_mut().kernel.set_white(arg(a, 0).num() as f32, arg(a, 1).num() as f32);
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "run", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let n = copy_into(s.kernel.stream_mut(), arg(a, 0).f32s(), arg(a, 1).int().max(0) as usize);
            s.kernel.run(n);
            Val::U32s(s.kernel.stats().to_vec())
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "createBatch", Box::new(move |a| Val::Num(st.borrow_mut().kernel.batch_create(arg(a, 0).int().max(1) as usize) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setBatchData", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let id = arg(a, 0).int();
            let count = arg(a, 2).int().max(0) as usize;
            if let Some(dst) = s.kernel.batch_data(id) {
                copy_into(dst, arg(a, 1).f32s(), count * 8);
            }
            s.kernel.batch_set_count(id, count);
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "destroyBatch", Box::new(move |a| {
            st.borrow_mut().kernel.batch_destroy(arg(a, 0).int());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "createEmitter", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let words = arg(a, 1).int().max(0) as usize;
            copy_into(s.kernel.scratch_mut(), arg(a, 0).f32s(), words);
            Val::Num(s.kernel.emitter_create(words) as f64)
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "burst", Box::new(move |a| {
            st.borrow_mut().kernel.emitter_burst(arg(a, 0).int(), arg(a, 1).int().max(0) as usize, arg(a, 2).num(), arg(a, 3).num());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "emitterCount", Box::new(move |a| Val::Num(st.borrow().kernel.emitter_count(arg(a, 0).int()) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "clearEmitter", Box::new(move |a| {
            st.borrow_mut().kernel.emitter_clear(arg(a, 0).int());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "destroyEmitter", Box::new(move |a| {
            st.borrow_mut().kernel.emitter_destroy(arg(a, 0).int());
            Val::Undefined
        }));
        // node tables: the script keeps a mirror and sends dirty ranges; reads pull the table back
        let st = state.clone();
        reg(e, "__blackironKernelNative", "createNodes", Box::new(move |a| Val::Num(st.borrow_mut().kernel.nodes_create(arg(a, 0).int().max(1) as usize) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "nodesData", Box::new(move |a| Val::F32s(st.borrow_mut().kernel.nodes(arg(a, 0).int()).map(|t| t.data.clone()).unwrap_or_default())));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setNodesData", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let (from, to) = (arg(a, 2).int().max(0) as usize * NODE_WORDS, arg(a, 3).int().max(0) as usize * NODE_WORDS);
            if let Some(t) = s.kernel.nodes(arg(a, 0).int()) {
                let src = arg(a, 1).f32s();
                let to = to.min(t.data.len()).min(from + src.len());
                if to > from {
                    t.data[from..to].copy_from_slice(&src[..to - from]);
                }
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "allocNode", Box::new(move |a| Val::Num(st.borrow_mut().kernel.nodes(arg(a, 0).int()).map(|t| t.alloc()).unwrap_or(-1) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "freeNode", Box::new(move |a| {
            if let Some(t) = st.borrow_mut().kernel.nodes(arg(a, 0).int()) {
                t.free(arg(a, 1).int());
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "clearNodes", Box::new(move |a| {
            if let Some(t) = st.borrow_mut().kernel.nodes(arg(a, 0).int()) {
                t.clear();
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "nodeCount", Box::new(move |a| Val::Num(st.borrow_mut().kernel.nodes(arg(a, 0).int()).map(|t| t.live).unwrap_or(0) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "nodesHigh", Box::new(move |a| Val::Num(st.borrow_mut().kernel.nodes(arg(a, 0).int()).map(|t| t.high).unwrap_or(0) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "stepNodes", Box::new(move |a| {
            if let Some(t) = st.borrow_mut().kernel.nodes(arg(a, 0).int()) {
                t.step(arg(a, 1).num());
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "configureNodes", Box::new(move |a| {
            let p = arg(a, 1).nums();
            let g = |i: usize| p.get(i).copied().unwrap_or(0.0);
            if let Some(t) = st.borrow_mut().kernel.nodes(arg(a, 0).int()) {
                t.configure(g(0), g(1), g(2), g(3).max(0.0) as u32, [g(4), g(5), g(6), g(7)]);
                t.gravity_z = g(8);
                t.floor = g(9).max(0.0) as u32;
            }
            Val::Undefined
        }));
        // world-space batches and the shadow region
        let st = state.clone();
        reg(e, "__blackironKernelNative", "createBatch3", Box::new(move |a| Val::Num(st.borrow_mut().kernel.batch3_create(arg(a, 0).int().max(1) as usize) as f64)));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setBatch3Data", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let id = arg(a, 0).int();
            let count = arg(a, 2).int().max(0) as usize;
            if let Some(dst) = s.kernel.batch3_data(id) {
                copy_into(dst, arg(a, 1).f32s(), count * blackiron_kernel::BATCH3_STRIDE);
            }
            s.kernel.batch3_set_count(id, count);
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "destroyBatch3", Box::new(move |a| {
            st.borrow_mut().kernel.batch3_destroy(arg(a, 0).int());
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setShadow", Box::new(move |a| {
            let v = |i: usize| arg(a, i).num() as f32;
            st.borrow_mut().kernel.set_shadow(v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7));
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "setNodeFrames", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let words = arg(a, 2).int().max(0) as usize;
            copy_into(s.kernel.scratch_mut(), arg(a, 1).f32s(), words);
            s.kernel.nodes_set_frames(arg(a, 0).int(), words);
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "applyNodeTransforms", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let words = arg(a, 2).int().max(0) as usize;
            copy_into(s.kernel.scratch_mut(), arg(a, 1).f32s(), words);
            Val::Num(s.kernel.nodes_apply_transforms(arg(a, 0).int(), words) as f64)
        }));
        let st = state.clone();
        reg(e, "__blackironKernelNative", "destroyNodes", Box::new(move |a| {
            st.borrow_mut().kernel.nodes_destroy(arg(a, 0).int());
            Val::Undefined
        }));

        // audio
        let st = state.clone();
        reg(e, "__blackironAudioNative", "available", Box::new(move |_| Val::Bool(st.borrow().audio.is_some())));
        reg(e, "__blackironAudioNative", "unlock", Box::new(|_| Val::Undefined));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "time", Box::new(move |_| Val::Num(st.borrow().audio.as_ref().and_then(|a| a.lock().ok().map(|a| a.time())).unwrap_or(0.0))));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "peak", Box::new(move |_| Val::Num(st.borrow().audio.as_ref().and_then(|a| a.lock().ok().map(|a| a.peak() as f64)).unwrap_or(0.0))));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "command", Box::new(move |a| {
            let s = st.borrow();
            if let Some(audio) = &s.audio {
                if let Ok(mut audio) = audio.lock() {
                    let n = copy_into(audio.scratch_mut(), arg(a, 0).f32s(), arg(a, 1).int().max(0) as usize);
                    audio.command(n);
                }
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "loadSample", Box::new(move |a| {
            let s = st.borrow();
            match &s.audio {
                Some(audio) => Val::Bool(crate::audio::load_sample(audio, s.audio_rate, arg(a, 0).int(), arg(a, 1).bytes())),
                None => Val::Bool(false),
            }
        }));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "loadStream", Box::new(move |a| {
            let s = st.borrow();
            let Some(audio) = &s.audio else { return Val::Num(0.0) };
            let Ok(mut audio) = audio.lock() else { return Val::Num(0.0) };
            let id = arg(a, 0).int();
            let bytes = arg(a, 1).bytes();
            if !audio.stream_begin(id, bytes.len()) || !audio.stream_write_bytes(id, &bytes) {
                return Val::Num(0.0);
            }
            Val::Num(audio.stream_open(id) as f64)
        }));
        let st = state.clone();
        reg(e, "__blackironAudioNative", "closeStream", Box::new(move |a| {
            let s = st.borrow();
            if let Some(audio) = &s.audio {
                if let Ok(mut audio) = audio.lock() {
                    audio.stream_close(arg(a, 0).int());
                }
            }
            Val::Undefined
        }));

        // physics: worlds by id; results come back as a copy of the first scratch words
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "create", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let world = Physics::new(arg(a, 0).num() as f32);
            let id = match s.physics.iter().position(|w| w.is_none()) {
                Some(i) => {
                    s.physics[i] = Some(world);
                    i
                }
                None => {
                    s.physics.push(Some(world));
                    s.physics.len() - 1
                }
            };
            Val::Num(id as f64)
        }));
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "call", Box::new(move |a| {
            let mut s = st.borrow_mut();
            let Some(Some(world)) = s.physics.get_mut(arg(a, 0).int() as usize) else { return Val::Num(-1.0) };
            let words = arg(a, 3).int().max(0) as usize;
            copy_into(world.scratch_mut(), arg(a, 2).f32s(), words);
            Val::Num(world.call(arg(a, 1).int().max(0) as u32, words) as f64)
        }));
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "results", Box::new(move |a| Val::F32s(match st.borrow().physics.get(arg(a, 0).int() as usize) {
            Some(Some(world)) => world.scratch()[..256].to_vec(),
            _ => Vec::new(),
        })));
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "transforms", Box::new(move |a| Val::F32s(match st.borrow().physics.get(arg(a, 0).int() as usize) {
            Some(Some(world)) => world.transforms().to_vec(),
            _ => Vec::new(),
        })));
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "events", Box::new(move |a| Val::F32s(match st.borrow().physics.get(arg(a, 0).int() as usize) {
            Some(Some(world)) => world.events().to_vec(),
            _ => Vec::new(),
        })));
        let st = state.clone();
        reg(e, "__blackironPhysicsNative", "destroy", Box::new(move |a| {
            if let Some(slot) = st.borrow_mut().physics.get_mut(arg(a, 0).int() as usize) {
                *slot = None;
            }
            Val::Undefined
        }));
        let st = state.clone();
        reg(e, "", "__blackironKeyboard", Box::new(move |a| {
            st.borrow_mut().keyboard = Some(arg(a, 0).truthy());
            Val::Undefined
        }));
        e.eval(GLUE, "blackiron-glue.js");
        Js { engine, state }
    }

    pub fn engine_name(&self) -> &'static str {
        self.engine.name()
    }

    /// Run the game script and its boot function.
    pub fn boot(&mut self, source: &str) {
        let script = format!("{source}\n;__blackironBoot().catch(e => __blackironHost.bootFailed(String(e) + ' ' + (e && e.stack || '')));");
        self.engine.eval(&script, "game.js");
        self.engine.pump();
    }

    pub fn pump(&mut self) {
        self.engine.pump();
    }

    /// Advance timers, run one engine frame, then drain promise jobs.
    pub fn tick(&mut self, now_ms: f64) {
        self.engine.call("", "__blackironRunTimers", &[Val::Num(now_ms)]);
        self.engine.call("__blackiron", "frame", &[Val::Num(now_ms)]);
        self.engine.pump();
    }

    pub fn pointer_capture(&mut self, locked:bool) { self.engine.call("__blackiron","pointerCapture",&[Val::Bool(locked)]); }
    pub fn mouse_motion(&mut self,x:f64,y:f64) { self.engine.call("__blackiron","mouseMotion",&[Val::Num(x),Val::Num(y)]); }
    pub fn pointer(&mut self, kind: &str, id: i64, x: f64, y: f64, ty: &str) {
        self.engine.call("__blackiron", "pointer", &[Val::Str(kind.into()), Val::Num(id as f64), Val::Num(x), Val::Num(y), Val::Str(ty.into())]);
    }

    /// A pointer event in logical units, for scripted taps.
    pub fn pointer_logical(&mut self, kind: &str, id: i64, x: f64, y: f64) {
        self.engine.call("__blackiron", "pointerLogical", &[Val::Str(kind.into()), Val::Num(id as f64), Val::Num(x), Val::Num(y)]);
    }

    pub fn key(&mut self, code: &str, down: bool) {
        self.engine.call("__blackiron", "key", &[Val::Str(code.into()), Val::Bool(down)]);
    }

    pub fn resize(&mut self, screen: &Screen) {
        self.engine.set("__blackironHost", "screen", screen_value(screen));
        self.engine.call("__blackiron", "resize", &[Val::Num(screen.width), Val::Num(screen.height), Val::Num(screen.scale), Val::Nums(screen.insets.to_vec())]);
    }

    pub fn visibility(&mut self, visible: bool) {
        self.engine.call("__blackiron", "visibility", &[Val::Bool(visible)]);
    }

    pub fn text(&mut self, text: &str) {
        self.engine.call("__blackiron", "text", &[Val::Str(text.into())]);
    }

    pub fn wheel(&mut self, dy: f64) {
        self.engine.call("__blackiron", "wheel", &[Val::Num(dy)]);
    }
}

fn screen_value(s: &Screen) -> Val {
    Val::Obj(vec![("width".into(), Val::Num(s.width)), ("height".into(), Val::Num(s.height)), ("scale".into(), Val::Num(s.scale)), ("insets".into(), Val::Nums(s.insets.to_vec()))])
}

fn decode_image(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(bytes));
        decoder.read_info().ok()?;
        let info = decoder.info()?;
        if u64::from(info.width) * u64::from(info.height) > 16_777_216 { return None; }
        let pixels = decoder.decode().ok()?;
        let mut rgba = Vec::with_capacity(usize::from(info.width) * usize::from(info.height) * 4);
        match info.pixel_format {
            jpeg_decoder::PixelFormat::RGB24 => for p in pixels.chunks_exact(3) {
                rgba.extend_from_slice(&[p[0], p[1], p[2], 255]);
            },
            jpeg_decoder::PixelFormat::L8 => for p in pixels { rgba.extend_from_slice(&[p, p, p, 255]); },
            _ => return None,
        }
        return Some((u32::from(info.width), u32::from(info.height), rgba));
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    if u64::from(reader.info().width) * u64::from(reader.info().height) > 16_777_216 { return None; }
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (w, h) = (info.width, info.height);
    let n = (w * h) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..n * 4].to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(n * 4);
            for px in buf[..n * 3].chunks(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(n * 4);
            for px in buf[..n * 2].chunks(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(n * 4);
            for &g in &buf[..n] {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        _ => return None,
    };
    Some((w, h, rgba))
}

#[cfg(test)]
mod image_tests {
    use super::decode_image;
    #[test]
    fn embedded_png_and_jpeg_decode_to_rgba() {
        for bytes in [
            include_bytes!("../../tests/fixtures/gltf/checker.png").as_slice(),
            include_bytes!("../../tests/fixtures/gltf/checker.jpg").as_slice(),
        ] {
            let (w, h, rgba) = decode_image(bytes).expect("image should decode");
            assert_eq!((w, h), (2, 2));
            assert_eq!(rgba.len(), 16);
            assert!(rgba.chunks_exact(4).all(|p| p[3] == 255));
            assert!(rgba.chunks_exact(4).any(|p| p[0] > 100 || p[1] > 100 || p[2] > 100));
        }
        assert!(decode_image(b"invalid").is_none());
        assert!(decode_image(&[0xff, 0xd8, 0]).is_none());
    }
}
