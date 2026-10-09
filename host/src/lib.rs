//! Kiln's generic native host. One codebase for Windows, Linux, macOS and Android: winit
//! for the window and input, wgpu for the GPU, QuickJS for the game, cpal for audio, and
//! the kernel for everything heavy. The Swift host stays the Apple-polished alternative.

pub mod audio;
pub mod bundle;
pub mod input;
pub mod js;
pub mod script;
pub mod storage;
pub mod text;
#[cfg(target_os = "android")]
pub mod android;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use winit::application::ApplicationHandler;
use winit::event::{DeviceEvent, DeviceId,ElementState, MouseButton, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::PhysicalKey;
use winit::window::{CursorGrabMode,Window, WindowId};

use bundle::Bundle;
use js::{Js, Screen, TextureUpload};
use script::EngineKind;
use kiln_kernel::render::{Frame, Renderer, SurfaceSource};
use winit::raw_window_handle::{HasDisplayHandle, HasWindowHandle};

pub const MAX_QUADS: usize = 32768;
pub const STREAM_WORDS: usize = 1 << 18;

pub struct RunOptions {
    pub bundle: Bundle,
    pub data_dir: PathBuf,
    pub title: String,
    pub size: (f64, f64),
    pub fullscreen: bool,
    pub snapshot: Option<PathBuf>,
    pub snapshot_frame: u64,
    pub exit_after_snapshot: bool,
    /// Scripted pointer taps for screenshot tests: logical x, y and the frame to press on.
    pub taps: Vec<(f64, f64, u64)>,
    /// Which JavaScript engine runs the game.
    pub engine: EngineKind,
    /// Milliseconds per frame for a synthetic clock (screenshot tests); None means real time.
    pub fixed_dt: Option<f64>,
}

struct App {
    opts: Option<RunOptions>,
    title: String,
    size: (f64, f64),
    fullscreen: bool,
    snapshot: Option<PathBuf>,
    snapshot_frame: u64,
    exit_after_snapshot: bool,
    snapshot_done: bool,
    taps: Vec<(f64, f64, u64)>,
    fixed_dt: Option<f64>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    js: Option<Js>,
    audio: Option<audio::AudioOut>,
    gamepads: input::Gamepads,
    textures: [Option<TextureUpload>; 3],
    start: Instant,
    mouse: (f64, f64),
    mouse_down: bool,
    pointer_captured: bool,
    relative_mouse: input::RelativeMouse,
    /// When the last frame ran; the loop drives one itself if the window stops asking.
    last_frame: Instant,
    in_frame: bool,
    /// Diagnostics: frames run, frames the script submitted, and whether a stall was reported.
    frames_run: u64,
    frames_submitted: u64,
    last_submit: Instant,
    stall_reported: bool,
}

impl App {
    fn screen(&self) -> Screen {
        let w = self.window.as_ref().expect("window");
        let scale = w.scale_factor().max(0.5);
        // A scripted run (a snapshot) is laid out at the size it asked for, whatever the window
        // manager did to the window: a display shorter than a phone must not change the frame.
        if self.snapshot.is_some() && self.size.0 > 0.0 && self.size.1 > 0.0 {
            return Screen { width: self.size.0, height: self.size.1, scale, insets: [0.0; 4] };
        }
        let size = w.inner_size();
        Screen { width: size.width.max(1) as f64 / scale, height: size.height.max(1) as f64 / scale, scale, insets: [0.0; 4] }
    }

    fn frame(&mut self, el: &ActiveEventLoop) {
        if self.in_frame {
            return;
        }
        self.in_frame = true;
        self.last_frame = Instant::now();
        self.frame_inner(el);
        self.in_frame = false;
    }

    fn frame_inner(&mut self, el: &ActiveEventLoop) {
        let (Some(js), Some(renderer)) = (&mut self.js, &mut self.renderer) else { return };
        // A scripted run takes only its scripted taps: a pad button at startup, or a key the
        // developer pressed while the window had focus, must not press Play on a golden.
        let scripted = self.snapshot.is_some();
        for (code, down) in if scripted { Vec::new() } else { self.gamepads.poll() } {
            #[cfg(target_os = "android")]
            log::info!("controller: {code} {}", if down { "down" } else { "up" });
            js.key(&code, down);
        }
        // Scripted time counts the frames the script submitted, not the frames the GPU showed:
        // a surface lost to a window-manager resize drops a presented frame, and a clock or a
        // tap keyed to presented frames would drift by a tick and change the golden.
        let tick = self.frames_submitted;
        let now = match self.fixed_dt {
            Some(dt) => {
                let t = tick as f64 * dt;
                js.state.borrow_mut().clock = Some(t);
                t
            }
            None => self.start.elapsed().as_secs_f64() * 1000.0,
        };
        for &(x, y, frame) in &self.taps {
            if tick == frame {
                js.pointer_logical("down", 1, x, y);
            } else if tick == frame + 1 {
                js.pointer_logical("up", 1, x, y);
            }
        }
        if self.pointer_captured {let (x,y)=self.relative_mouse.take();if x!=0.0||y!=0.0 {js.mouse_motion(x,y);}}
        js.tick(now);
        if js.state.borrow().boot_failed {el.exit();return;}
        let (uploads, frame, haptics, keyboard, announcements) = {
            let mut s = js.state.borrow_mut();
            (std::mem::take(&mut s.uploads), s.frame.take(), std::mem::take(&mut s.haptics), s.keyboard.take(), std::mem::take(&mut s.announcements))
        };
        self.frames_run += 1;
        if frame.is_some() {
            self.frames_submitted += 1;
            self.last_submit = Instant::now();
        } else if self.frames_submitted > 0 && !self.stall_reported {
            self.stall_reported = true;
            log::warn!("the script submitted no frame (run {}, submitted {})", self.frames_run, self.frames_submitted);
        }
        let capture_request=js.state.borrow_mut().pointer_capture.take();
        if let (Some(capture),Some(w))=(capture_request,&self.window) {
            self.pointer_captured = capture && self.snapshot.is_none() && (w.set_cursor_grab(CursorGrabMode::Locked).is_ok() || w.set_cursor_grab(CursorGrabMode::Confined).is_ok());
            if !self.pointer_captured {let _=w.set_cursor_grab(CursorGrabMode::None);}
            w.set_cursor_visible(!self.pointer_captured);
            self.relative_mouse.reset();
            log::info!("mouse capture: {}",self.pointer_captured);
            js.pointer_capture(self.pointer_captured);
        }
        if let (Some(show), Some(w)) = (keyboard, &self.window) {
            // On phones this raises the soft keyboard; on desktops it only enables IME text.
            w.set_ime_allowed(show);
        }
        if let Some(packet) = js.state.borrow_mut().mesh_packet.take() {
            if let Err(error) = renderer.submit_mesh(&packet) { log::error!("3D submission failed: {error}"); }
        }
        js.state.borrow_mut().mesh_resources = renderer.mesh_resources();
        for u in uploads {
            let slot = u.slot;
            renderer.upload_texture(slot, u.w, u.h, &u.rgba);
            if slot < 3 {
                self.textures[slot] = Some(u);
            }
        }
        #[cfg(target_os = "android")]
        for kind in haptics {
            android::haptic(&kind);
        }
        #[cfg(not(target_os = "android"))]
        drop(haptics);
        #[cfg(target_os = "android")]
        for text in announcements {
            android::announce(&text);
        }
        #[cfg(not(target_os = "android"))]
        for text in announcements {
            // Desktops have no screen-reader bridge yet; the log keeps the intent visible.
            log::info!("announce: {text}");
        }
        if std::env::var_os("KILN_TRACE").is_some() {
            log::info!("frame {} submitted={} keyboard={:?}", renderer.frames, frame.is_some(), keyboard);
        }
        if let Some(f) = frame {
            let s = js.state.borrow();
            let stats = s.kernel.stats();
            let vertex_count = f.vertex_count.min(stats[0] as usize);
            let command_count = f.command_count.min(s.kernel.commands().len());
            let want_snapshot = self.snapshot.is_some() && !self.snapshot_done && tick >= self.snapshot_frame;
            let mut ok = renderer.render(Frame { vertices: s.kernel.vertices(), vertex_count, commands: &s.kernel.commands()[..command_count], post: &f.post }, want_snapshot);
            if want_snapshot && !ok {
                // The surface was lost on the frame we wanted: the kernel still holds it, so draw it again.
                for _ in 0..3 {
                    ok = renderer.render(Frame { vertices: s.kernel.vertices(), vertex_count, commands: &s.kernel.commands()[..command_count], post: &f.post }, true);
                    if ok {
                        break;
                    }
                }
            }
            if ok && want_snapshot {
                self.snapshot_done = true;
                if let (Some((w, h, rgba)), Some(path)) = (renderer.capture.take(), &self.snapshot) {
                    match write_png(path, w, h, &rgba) {
                        Ok(()) => log::info!("snapshot written to {}", path.display()),
                        Err(e) => log::warn!("snapshot failed: {e}"),
                    }
                }
                if self.exit_after_snapshot {
                    el.exit();
                }
            }
        }
    }
}

impl ApplicationHandler for App {
    fn device_event(&mut self,_el:&ActiveEventLoop,_id:DeviceId,event:DeviceEvent) {
        if self.pointer_captured && self.snapshot.is_none() {
            if let DeviceEvent::MouseMotion{delta}=event {self.relative_mouse.raw(delta.0,delta.1);}
        }
    }
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.window.is_none() {
            let mut attrs = Window::default_attributes().with_title(self.title.clone());
            if self.fullscreen {
                attrs = attrs.with_fullscreen(Some(winit::window::Fullscreen::Borderless(None)));
            } else {
                attrs = attrs.with_inner_size(winit::dpi::LogicalSize::new(self.size.0, self.size.1));
            }
            // A scripted run (a snapshot) never shows its window: nothing to steal focus, nothing
            // for the window manager to shrink, no key or click of the developer's to leak in.
            if self.snapshot.is_some() {
                attrs = attrs.with_visible(false);
            }
            let window = Arc::new(el.create_window(attrs).expect("window"));
            self.window = Some(window.clone());
            self.renderer = Some(make_renderer(&window, if self.snapshot.is_some() && self.size.0 > 0.0 { Some(self.size) } else { None }));
            let opts = self.opts.take().expect("options");
            // Snapshot runs are unattended visual tests. Do not open a system audio stream.
            let audio = if self.snapshot.is_some() { None } else { audio::start() };
            let (shared, rate) = match &audio {
                Some(a) => (Some(a.audio.clone()), a.sample_rate),
                None => (None, 48000),
            };
            self.audio = audio;
            let slug: String = opts.title.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
            let storage = storage::Storage::open(opts.data_dir.clone(), &slug);
            let text = text::TextSystem::new(&opts.bundle);
            let source = opts.bundle.read_text("game.js").unwrap_or_default();
            let screen = self.screen();
            let mut js = Js::new(opts.engine, opts.bundle, storage, text, shared, rate, screen, MAX_QUADS, STREAM_WORDS, opts.fixed_dt.is_some());
            if source.is_empty() {
                log::error!("game.js missing from the bundle");
            }
            js.boot(&source);
            log::info!("{} running on {} ({})", self.title, std::env::consts::OS, js.engine_name());
            self.js = Some(js);
        } else if self.renderer.is_none() {
            // Back from suspension (Android): the surface is new, textures must be re-uploaded.
            let window = self.window.clone().unwrap();
            let mut r = make_renderer(&window, if self.snapshot.is_some() && self.size.0 > 0.0 { Some(self.size) } else { None });
            for t in self.textures.iter().flatten() {
                r.upload_texture(t.slot, t.w, t.h, &t.rgba);
            }
            self.renderer = Some(r);
            let screen = self.screen();
            if let Some(js) = &mut self.js {
                js.resize(&screen);
                js.visibility(true);
            }
        }
    }

    fn suspended(&mut self, _el: &ActiveEventLoop) {
        if let Some(js) = &mut self.js {
            js.visibility(false);
        }
        self.renderer = None;
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if self.snapshot.is_some() && matches!(event, WindowEvent::KeyboardInput { .. } | WindowEvent::CursorMoved { .. } | WindowEvent::MouseInput { .. } | WindowEvent::MouseWheel { .. } | WindowEvent::Touch(_) | WindowEvent::Ime(_)) {
            return;
        }
        match event {
            WindowEvent::Focused(false) => {
                self.pointer_captured=false;self.mouse_down=false;self.relative_mouse.reset();
                if let Some(w)=&self.window {let _=w.set_cursor_grab(CursorGrabMode::None);w.set_cursor_visible(true);}
                if let Some(js)=&mut self.js {js.state.borrow_mut().pointer_capture=None;js.pointer_capture(false);}
            }
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(size) => {
                // Scripted runs keep the size they asked for; see `screen`.
                if self.snapshot.is_some() {
                    return;
                }
                if let Some(r) = &mut self.renderer {
                    r.resize(size.width, size.height);
                }
                let screen = self.screen();
                if let Some(js) = &mut self.js {
                    js.resize(&screen);
                }
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                let screen = self.screen();
                if let Some(js) = &mut self.js {
                    js.resize(&screen);
                }
            }
            WindowEvent::RedrawRequested => self.frame(el),
            WindowEvent::KeyboardInput { event, .. } => {
                let Some(js) = &mut self.js else { return };
                let pressed = event.state == ElementState::Pressed;
                if let PhysicalKey::Code(code) = event.physical_key {
                    if !event.repeat || pressed {
                        if !event.repeat {
                            js.key(&input::key_name(code), pressed);
                        }
                    }
                }
                // Printable characters go to text fields as typed text.
                if pressed {
                    if let Some(text) = &event.text {
                        if text.chars().all(|c| !c.is_control()) && !text.is_empty() {
                            js.text(text);
                        }
                    }
                }
            }
            WindowEvent::Ime(winit::event::Ime::Commit(text)) => {
                if let Some(js) = &mut self.js {
                    js.text(&text);
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => -(y as f64) * 40.0,
                    winit::event::MouseScrollDelta::PixelDelta(p) => -p.y / self.window.as_ref().map(|w| w.scale_factor()).unwrap_or(1.0),
                };
                if let Some(js) = &mut self.js {
                    js.wheel(dy);
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.window.as_ref().map(|w| w.scale_factor()).unwrap_or(1.0);
                self.mouse = (position.x / scale, position.y / scale);
                if self.pointer_captured {self.relative_mouse.cursor(position.x,position.y);}
                if self.mouse_down && !self.pointer_captured {
                    if let Some(js) = &mut self.js {
                        js.pointer("move", 1, self.mouse.0, self.mouse.1, "mouse");
                    }
                }
            }
            WindowEvent::MouseInput { state, button, .. } if self.pointer_captured => {
                let code=match button {MouseButton::Left=>Some("Mouse0"),MouseButton::Middle=>Some("Mouse1"),MouseButton::Right=>Some("Mouse2"),_=>None};
                if let (Some(code),Some(js))=(code,&mut self.js){js.key(code,state==ElementState::Pressed);}
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                self.mouse_down = state == ElementState::Pressed;
                if let Some(js) = &mut self.js {
                    js.pointer(if self.mouse_down { "down" } else { "up" }, 1, self.mouse.0, self.mouse.1, "mouse");
                }
            }
            WindowEvent::Touch(t) => {
                let scale = self.window.as_ref().map(|w| w.scale_factor()).unwrap_or(1.0);
                let kind = match t.phase {
                    TouchPhase::Started => "down",
                    TouchPhase::Moved => "move",
                    TouchPhase::Ended => "up",
                    TouchPhase::Cancelled => "cancel",
                };
                if let Some(js) = &mut self.js {
                    js.pointer(kind, t.id as i64, t.location.x / scale, t.location.y / scale, "touch");
                }
            }
            WindowEvent::Occluded(occluded) => {
                // A covered window pauses the game, except in scripted runs (snapshots, a fixed
                // clock): those windows land wherever macOS puts them, often under another one.
                let scripted = self.snapshot.is_some() || self.fixed_dt.is_some();
                if let (Some(js), false) = (&mut self.js, scripted) {
                    js.visibility(!occluded);
                }
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        // Ask for a redraw, and wake up on a timer regardless: on macOS a redraw request can be
        // coalesced away after input, and the loop would otherwise park with no frame pending.
        if let Some(w) = &self.window {
            w.request_redraw();
        }
        if self.js.is_some() && self.last_frame.elapsed() > std::time::Duration::from_millis(40) {
            self.frame(el);
        }
        if self.frames_submitted > 0 && !self.stall_reported && self.last_submit.elapsed() > std::time::Duration::from_secs(3) {
            self.stall_reported = true;
            log::warn!("no frame for 3 s (run {}, submitted {}, renderer frames {})", self.frames_run, self.frames_submitted, self.renderer.as_ref().map(|r| r.frames).unwrap_or(0));
        }
        el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + std::time::Duration::from_millis(8)));
    }
}

/// The kernel's renderer on a winit window; the window outlives it (the host keeps the Arc).
fn make_renderer(window: &Arc<Window>, scripted: Option<(f64, f64)>) -> Renderer {
    // A scripted run renders at the size it asked for even when the window manager shrank the window.
    let size = match scripted {
        Some((w, h)) => {
            let s = window.scale_factor().max(0.5);
            winit::dpi::PhysicalSize::new((w * s).round().max(1.0) as u32, (h * s).round().max(1.0) as u32)
        }
        None => window.inner_size(),
    };
    let source = SurfaceSource::Raw { display: window.display_handle().expect("display handle").as_raw(), window: window.window_handle().expect("window handle").as_raw() };
    Renderer::new(source, size.width, size.height, MAX_QUADS)
}

fn write_png(path: &std::path::Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())
}

/// Run a game bundle in a window until it closes.
pub fn run(event_loop: EventLoop<()>, opts: RunOptions) {
    event_loop.set_control_flow(ControlFlow::Poll);
    let mut app = App {
        title: opts.title.clone(),
        size: opts.size,
        fullscreen: opts.fullscreen,
        snapshot: opts.snapshot.clone(),
        snapshot_frame: opts.snapshot_frame,
        exit_after_snapshot: opts.exit_after_snapshot,
        snapshot_done: false,
        taps: opts.taps.clone(),
        fixed_dt: opts.fixed_dt,
        opts: Some(opts),
        window: None,
        renderer: None,
        js: None,
        audio: None,
        gamepads: input::Gamepads::new(),
        textures: [None, None, None],
        start: Instant::now(),
        mouse: (0.0, 0.0),
        mouse_down: false,
        pointer_captured:false,
        relative_mouse:input::RelativeMouse::default(),
        last_frame: Instant::now(),
        in_frame: false,
        frames_run: 0,
        frames_submitted: 0,
        last_submit: Instant::now(),
        stall_reported: false,
    };
    if let Err(e) = event_loop.run_app(&mut app) {
        log::error!("event loop: {e}");
    }
    // The script's closures hold context handles, so freeing the runtime would trip QuickJS's
    // leak check; the process is ending anyway.
    std::mem::forget(app);
}
