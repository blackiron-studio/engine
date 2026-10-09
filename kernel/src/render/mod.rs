//! The wgpu renderer, shared by every native host: it plays the kernel's command list into
//! scene, light and overlay targets, runs the two-level bloom chain and the composite, then
//! blits to the surface. wgpu picks Metal, Vulkan, DirectX 12 or OpenGL. Hosts hand over a
//! surface (raw window handles from a windowing library, or a CAMetalLayer from Swift) and
//! one frame per tick; the C ABI at the bottom is what Swift calls.

mod mesh;
use std::num::NonZeroU64;

use wgpu::util::DeviceExt;

pub use wgpu;

/// Where the renderer draws.
#[derive(Clone, Copy)]
pub enum SurfaceSource {
    /// Raw handles from winit or any windowing library.
    Raw { display: raw_window_handle::RawDisplayHandle, window: raw_window_handle::RawWindowHandle },
    /// A `CAMetalLayer *` (Apple platforms).
    MetalLayer(*mut std::ffi::c_void),
}

impl SurfaceSource {
    fn target(self) -> wgpu::SurfaceTargetUnsafe {
        match self {
            SurfaceSource::Raw { display, window } => wgpu::SurfaceTargetUnsafe::RawHandle { raw_display_handle: display, raw_window_handle: window },
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            SurfaceSource::MetalLayer(p) => wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(p),
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            SurfaceSource::MetalLayer(_) => panic!("CAMetalLayer surfaces exist only on Apple platforms"),
        }
    }
}

pub const FLOATS_PER_VERT: usize = 12;
const VERTEX_STRIDE: u64 = (FLOATS_PER_VERT * 4) as u64;
const UNIFORM_SLOT: u64 = 256;
const UNIFORM_SLOTS: u64 = 64;
const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

pub mod p {
    pub const BLOOM: usize = 0;
    pub const THRESHOLD: usize = 1;
    pub const PASSES: usize = 2;
    pub const VIGNETTE: usize = 3;
    pub const TINT_R: usize = 4;
    pub const TINT_G: usize = 5;
    pub const TINT_B: usize = 6;
    pub const TINT_AMOUNT: usize = 7;
    pub const SATURATION: usize = 8;
    pub const CONTRAST: usize = 9;
    pub const BRIGHTNESS: usize = 10;
    pub const USE_LUT: usize = 11;
    pub const GRAIN: usize = 12;
    pub const SCANLINES: usize = 13;
    pub const OFFSET_X: usize = 14;
    pub const OFFSET_Y: usize = 15;
    pub const LIGHTING: usize = 16;
    pub const VIEW_X: usize = 17;
    pub const VIEW_Y: usize = 18;
    pub const VIEW_W: usize = 19;
    pub const VIEW_H: usize = 20;
    pub const TARGET_W: usize = 21;
    pub const TARGET_H: usize = 22;
    pub const TIME: usize = 23;
    pub const LOGICAL_W: usize = 24;
    pub const LOGICAL_H: usize = 25;
    pub const SIZE: usize = 26;
}

const CMD_BEGIN: u32 = 1;
const CMD_PASS: u32 = 2;
const CMD_DRAW: u32 = 3;
const CMD_END: u32 = 4;
const CMD_SCISSOR: u32 = 5;

pub struct Frame<'a> {
    pub vertices: &'a [f32],
    pub vertex_count: usize,
    pub commands: &'a [u32],
    pub post: &'a [f32],
}

struct Target {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    w: u32,
    h: u32,
}

struct Targets {
    scene: Target,
    /// Normals of what the scene pass drew, for lit shading.
    normal: Target,
    overlay: Target,
    light: Target,
    /// Light-sized target one shadowed light draws into before it is added to the light.
    scratch: Target,
    bloom_a: Target,
    bloom_b: Target,
    bloom_c: Target,
    bloom_d: Target,
    present: Target,
    w: u32,
    h: u32,
}

pub struct Renderer {
    mesh: Option<mesh::MeshStage>,
    mesh_samples: u32,
    _instance: wgpu::Instance,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    sprite_pipeline: wgpu::RenderPipeline,
    /// The scene pass with a second colour target for normals.
    sprite_mrt_pipeline: wgpu::RenderPipeline,
    bright_pipeline: wgpu::RenderPipeline,
    blur_pipeline: wgpu::RenderPipeline,
    copy_pipeline: wgpu::RenderPipeline,
    composite_pipeline: wgpu::RenderPipeline,
    blit_pipeline: wgpu::RenderPipeline,
    sprite_layout: wgpu::BindGroupLayout,
    quad_layout: wgpu::BindGroupLayout,
    nearest: wgpu::Sampler,
    linear: wgpu::Sampler,
    index_buffer: wgpu::Buffer,
    index_quads: usize,
    vertex_buffer: wgpu::Buffer,
    max_quads: usize,
    uniforms: wgpu::Buffer,
    uniform_slot: u64,
    textures: [Option<(wgpu::Texture, wgpu::TextureView)>; 4],
    blank: (wgpu::Texture, wgpu::TextureView),
    targets: Option<Targets>,
    pub frames: u64,
    /// The last frame rendered with `capture`, as width, height and tightly packed RGBA.
    pub capture: Option<(u32, u32, Vec<u8>)>,
}

impl Renderer {
    /// Panics when no GPU adapter can present to the surface; hosts log that as fatal.
    pub fn new(source: SurfaceSource, width: u32, height: u32, max_quads: usize) -> Renderer {
        // One backend at a time: a surface created for Vulkan claims the native window, and an
        // EGL surface for the same window then fails. Native APIs first, then OpenGL; emulated
        // or software Vulkan (the Android emulator, SwiftShader, lavapipe) is only a last resort.
        let require_hardware = std::env::var("KILN_REQUIRE_HARDWARE_GPU").as_deref() == Ok("1");
        let (_instance, surface, adapter) = pick_adapter(source, wgpu::Backends::PRIMARY, false)
            .or_else(|| pick_adapter(source, wgpu::Backends::GL, false))
            .or_else(|| if require_hardware { None } else { pick_adapter(source, wgpu::Backends::all(), true) })
            .expect("no GPU adapter");
        let info = adapter.get_info();
        log::info!("gpu: {} ({:?}, {:?}, {})", info.name, info.backend, info.device_type, if is_emulated(&info) { "software/emulated" } else { "hardware" });
        if is_emulated(&info) { log::warn!("Software/emulated GPU selected; hardware acceleration is not certified. Set KILN_REQUIRE_HARDWARE_GPU=1 to require hardware."); }
        let color_samples = adapter.get_texture_format_features(TARGET_FORMAT).flags;
        let depth_samples = adapter.get_texture_format_features(wgpu::TextureFormat::Depth32Float).flags;
        let mesh_samples = if color_samples.contains(wgpu::TextureFormatFeatureFlags::MULTISAMPLE_X4 | wgpu::TextureFormatFeatureFlags::MULTISAMPLE_RESOLVE)
            && depth_samples.contains(wgpu::TextureFormatFeatureFlags::MULTISAMPLE_X4) { 4 } else { 1 };
        log::info!("native 3D mesh MSAA: {}x", mesh_samples);
        let request = |limits: wgpu::Limits| {
            pollster::block_on(adapter.request_device(
                &wgpu::DeviceDescriptor { label: Some("kiln"), required_features: wgpu::Features::empty(), required_limits: limits, memory_hints: wgpu::MemoryHints::default() },
                None,
            ))
        };
        let (device, queue) = match request(wgpu::Limits::default().using_resolution(adapter.limits())) {
            Ok(d) => d,
            Err(e) => {
                // OpenGL ES without compute, for one: ask for exactly what the adapter offers.
                log::warn!("default limits refused ({e}); using the adapter's own limits");
                request(adapter.limits()).expect("device")
            }
        };
        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("kiln shaders"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders.wgsl").into()),
        });
        let uniform_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let texture_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let sampler_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let sprite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sprite"),
            entries: &[uniform_entry(0), texture_entry(1), texture_entry(2), texture_entry(3), sampler_entry(4), sampler_entry(5), texture_entry(6), texture_entry(7), texture_entry(8)],
        });
        let mut quad_entries = vec![uniform_entry(0)];
        for i in 0..6 {
            quad_entries.push(texture_entry(1 + i));
        }
        for i in 0..6 {
            quad_entries.push(sampler_entry(7 + i));
        }
        let quad_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("quad"), entries: &quad_entries });
        let sprite_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[&sprite_layout], push_constant_ranges: &[] });
        let quad_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[&quad_layout], push_constant_ranges: &[] });

        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let vertex_layout = wgpu::VertexBufferLayout {
            array_stride: VERTEX_STRIDE,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 0, shader_location: 0 },
                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 8, shader_location: 1 },
                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 16, shader_location: 2 },
                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 32, shader_location: 3 },
                wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x2, offset: 40, shader_location: 4 },
            ],
        };
        let make = |label: &str, layout: &wgpu::PipelineLayout, vs: &str, fs: &str, buffers: &[wgpu::VertexBufferLayout], target: wgpu::TextureFormat, blend: Option<wgpu::BlendState>, topology: wgpu::PrimitiveTopology| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(layout),
                vertex: wgpu::VertexState { module: &shader, entry_point: Some(vs), buffers, compilation_options: Default::default() },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some(fs),
                    targets: &[Some(wgpu::ColorTargetState { format: target, blend, write_mask: wgpu::ColorWrites::ALL })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState { topology, ..Default::default() },
                depth_stencil: None,
                multisample: Default::default(),
                multiview: None,
                cache: None,
            })
        };
        let strip = wgpu::PrimitiveTopology::TriangleStrip;
        let sprite_pipeline = make("sprite", &sprite_pl, "sprite_vertex", "sprite_fragment", &[vertex_layout.clone()], TARGET_FORMAT, Some(blend), wgpu::PrimitiveTopology::TriangleList);
        let sprite_mrt_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("sprite-mrt"),
            layout: Some(&sprite_pl),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("sprite_vertex"), buffers: &[vertex_layout.clone()], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("sprite_fragment_mrt"),
                targets: &[
                    Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL }),
                    Some(wgpu::ColorTargetState { format: TARGET_FORMAT, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL }),
                ],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, ..Default::default() },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let bright_pipeline = make("bright", &quad_pl, "quad_vertex", "bright_fragment", &[], TARGET_FORMAT, None, strip);
        let blur_pipeline = make("blur", &quad_pl, "quad_vertex", "blur_fragment", &[], TARGET_FORMAT, None, strip);
        let copy_pipeline = make("copy", &quad_pl, "quad_vertex", "copy_fragment", &[], TARGET_FORMAT, None, strip);
        let composite_pipeline = make("composite", &quad_pl, "quad_vertex", "composite_fragment", &[], TARGET_FORMAT, None, strip);
        let blit_pipeline = make("blit", &quad_pl, "quad_vertex", "copy_fragment", &[], format, None, strip);

        let sampler = |filter: wgpu::FilterMode| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: filter,
                min_filter: filter,
                ..Default::default()
            })
        };
        let nearest = sampler(wgpu::FilterMode::Nearest);
        let linear = sampler(wgpu::FilterMode::Linear);
        let index_quads = max_quads.max(64);
        let index_buffer = Self::make_indices(&device, index_quads);
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("vertices"),
            size: (max_quads as u64) * 4 * VERTEX_STRIDE,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: UNIFORM_SLOT * UNIFORM_SLOTS,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let blank = Self::make_texture(&device, &queue, 1, 1, &[0, 0, 0, 0]);
        Renderer {
            mesh_samples,
            _instance,
            device,
            queue,
            surface,
            config,
            sprite_pipeline,
            sprite_mrt_pipeline,
            bright_pipeline,
            blur_pipeline,
            copy_pipeline,
            composite_pipeline,
            blit_pipeline,
            sprite_layout,
            quad_layout,
            nearest,
            linear,
            index_buffer,
            index_quads,
            vertex_buffer,
            max_quads,
            uniforms,
            uniform_slot: 0,
            mesh: None,
            textures: [None, None, None, None],
            blank,
            targets: None,
            frames: 0,
            capture: None,
        }
    }

    fn make_indices(device: &wgpu::Device, quads: usize) -> wgpu::Buffer {
        let mut idx = Vec::with_capacity(quads * 6);
        for i in 0..quads as u32 {
            let v = i * 4;
            idx.extend_from_slice(&[v, v + 1, v + 2, v, v + 2, v + 3]);
        }
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("indices"), contents: bytemuck::cast_slice(&idx), usage: wgpu::BufferUsages::INDEX })
    }

    fn make_texture(device: &wgpu::Device, queue: &wgpu::Queue, w: u32, h: u32, rgba: &[u8]) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w.max(1) * 4), rows_per_image: Some(h.max(1)) },
            wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
        );
        let view = texture.create_view(&Default::default());
        (texture, view)
    }

    fn make_target(&self, w: u32, h: u32, copy_src: bool) -> Target {
        let w = w.max(1);
        let h = h.max(1);
        let mut usage = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        if copy_src {
            usage |= wgpu::TextureUsages::COPY_SRC;
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: TARGET_FORMAT,
            usage,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        Target { texture, view, w, h }
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        if w == 0 || h == 0 {
            return;
        }
        self.config.width = w;
        self.config.height = h;
        self.surface.configure(&self.device, &self.config);
    }

    pub fn upload_texture(&mut self, slot: usize, w: u32, h: u32, rgba: &[u8]) {
        if slot >= 4 || (w * h * 4) as usize > rgba.len() {
            return;
        }
        self.textures[slot] = Some(Self::make_texture(&self.device, &self.queue, w, h, rgba));
    }

    fn ensure_targets(&mut self, w: u32, h: u32) {
        let (sw, sh) = (self.config.width, self.config.height);
        if let Some(t) = &self.targets {
            if t.w == w && t.h == h && t.present.w == sw && t.present.h == sh {
                return;
            }
        }
        self.targets = Some(Targets {
            scene: self.make_target(w, h, false),
            normal: self.make_target(w, h, false),
            overlay: self.make_target(w, h, false),
            light: self.make_target(w / 2, h / 2, false),
            scratch: self.make_target(w / 2, h / 2, false),
            bloom_a: self.make_target(w / 4, h / 4, false),
            bloom_b: self.make_target(w / 4, h / 4, false),
            bloom_c: self.make_target(w / 8, h / 8, false),
            bloom_d: self.make_target(w / 8, h / 8, false),
            present: self.make_target(sw, sh, true),
            w,
            h,
        });
    }

    fn uniform(&mut self, data: &[f32]) -> u64 {
        let offset = self.uniform_slot * UNIFORM_SLOT;
        self.uniform_slot = (self.uniform_slot + 1) % UNIFORM_SLOTS;
        self.queue.write_buffer(&self.uniforms, offset, bytemuck::cast_slice(data));
        offset
    }

    fn quad_group(&self, offset: u64, textures: [&wgpu::TextureView; 6], samplers: [&wgpu::Sampler; 6]) -> wgpu::BindGroup {
        let mut entries = vec![wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset, size: NonZeroU64::new(UNIFORM_SLOT) }),
        }];
        for (i, t) in textures.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry { binding: 1 + i as u32, resource: wgpu::BindingResource::TextureView(t) });
        }
        for (i, s) in samplers.iter().enumerate() {
            entries.push(wgpu::BindGroupEntry { binding: 7 + i as u32, resource: wgpu::BindingResource::Sampler(s) });
        }
        self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &self.quad_layout, entries: &entries })
    }

    /// Draw one frame; with `capture` the presented image is also read back into `capture`.
    /// Returns false when the surface was lost and the frame skipped.
    pub fn mesh_resources(&self) -> (usize, usize, usize) { self.mesh.as_ref().map(|m| m.resources()).unwrap_or((0, 0, 0)) }
    pub fn submit_mesh(&mut self, json: &str) -> Result<(), String> {
        let packet = mesh::Packet::parse(json)?;
        let stage = self.mesh.get_or_insert_with(|| mesh::MeshStage::new(&self.device, &self.queue, self.mesh_samples));
        stage.submit(&self.device, &self.queue, packet)
    }

    pub fn render(&mut self, frame: Frame, capture: bool) -> bool {
        let post = frame.post;
        if post.len() < p::SIZE {
            return false;
        }
        let tw = post[p::TARGET_W] as u32;
        let th = post[p::TARGET_H] as u32;
        if tw == 0 || th == 0 || self.config.width < 2 || self.config.height < 2 || !post.iter().all(|v| v.is_finite()) {
            return false;
        }
        self.ensure_targets(tw, th);
        let surface = match self.surface.get_current_texture() {
            Ok(s) => s,
            Err(wgpu::SurfaceError::Lost) | Err(wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                return false;
            }
            Err(e) => {
                log::warn!("surface: {e:?}");
                return false;
            }
        };
        let surface_view = surface.texture.create_view(&Default::default());
        let quads = (frame.vertex_count / 4).min(self.max_quads);
        if quads > self.index_quads {
            self.index_quads = (quads * 2).max(4096);
            self.index_buffer = Self::make_indices(&self.device, self.index_quads);
        }
        if quads > 0 {
            self.queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&frame.vertices[..quads * 4 * FLOATS_PER_VERT]));
        }

        // Decode the command list into draw segments per target. Each PASS op starts a new
        // sequence so the scratch target clears every time a light enters it.
        let mut clear = [0.0f64; 3];
        let mut light_clear = [0.25f64, 0.25, 0.3];
        let mut light_used = false;
        // Segments carry the scissor active when they were drawn, in logical units.
        let mut segments: Vec<(usize, u32, u32, Option<[u32; 4]>, u32)> = Vec::new();
        let mut current = 0usize;
        let mut pass_seq = 0u32;
        let mut scissor: Option<[u32; 4]> = None;
        let cmds = frame.commands;
        let mut i = 0;
        while i < cmds.len() {
            match cmds[i] {
                CMD_BEGIN => {
                    clear = rgb(cmds[i + 1]);
                    current = 0;
                    i += 2;
                }
                CMD_PASS => {
                    current = (cmds[i + 1] as usize).min(3);
                    if current == 1 {
                        // The ambient comes from the first switch into the light pass; later
                        // switches (after a shadowed light's scratch pass) carry no clear.
                        if !light_used {
                            light_clear = rgb(cmds[i + 2]);
                        }
                        light_used = true;
                    }
                    pass_seq += 1;
                    scissor = None;
                    i += 3;
                }
                CMD_DRAW => {
                    let first = cmds[i + 1];
                    let count = cmds[i + 2].min((quads as u32) * 4 - first.min(quads as u32 * 4));
                    if count >= 4 {
                        segments.push((current, first, count, scissor, pass_seq));
                    }
                    i += 3;
                }
                CMD_SCISSOR => {
                    scissor = if cmds[i + 3] == 0 || cmds[i + 4] == 0 { None } else { Some([cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]]) };
                    i += 5;
                }
                CMD_END => break,
                _ => break,
            }
        }
        let logical = (post[p::LOGICAL_W].max(1.0), post[p::LOGICAL_H].max(1.0));
        let normals_on = self.textures[3].is_some();

        // One uniform and bind group per target: the viewport plus that target's size, and the
        // normal buffer and scratch bound only where they are not being drawn.
        let sizes = {
            let t = self.targets.as_ref().unwrap();
            [(t.scene.w, t.scene.h), (t.light.w, t.light.h), (t.overlay.w, t.overlay.h), (t.scratch.w, t.scratch.h)]
        };
        let mut offsets4 = [0u64; 4];
        for target in 0..4 {
            offsets4[target] = self.uniform(&[post[p::LOGICAL_W], post[p::LOGICAL_H], sizes[target].0 as f32, sizes[target].1 as f32]);
        }
        let atlas = self.textures[0].as_ref().map(|t| &t.1).unwrap_or(&self.blank.1);
        let glyphs = self.textures[1].as_ref().map(|t| &t.1).unwrap_or(&self.blank.1);
        let lut = self.textures[2].as_ref().map(|t| &t.1).unwrap_or(&self.blank.1);
        let normals = self.textures[3].as_ref().map(|t| &t.1).unwrap_or(&self.blank.1);
        let t = self.targets.as_ref().unwrap();
        let blank = &self.blank.1;
        let mut groups = Vec::with_capacity(4);
        for target in 0..4 {
            let nb = if (target == 1 || target == 3) && normals_on { &t.normal.view } else { blank };
            let sc = if target == 1 { &t.scratch.view } else { blank };
            groups.push(self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("sprite"),
                layout: &self.sprite_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: offsets4[target], size: NonZeroU64::new(UNIFORM_SLOT) }) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(atlas) },
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(atlas) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(glyphs) },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.nearest) },
                    wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.linear) },
                    wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(normals) },
                    wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(nb) },
                    wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(sc) },
                ],
            }));
        }

        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        let clear_colors = [
            wgpu::Color { r: clear[0], g: clear[1], b: clear[2], a: 1.0 },
            wgpu::Color { r: light_clear[0], g: light_clear[1], b: light_clear[2], a: 1.0 },
            wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
            wgpu::Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        ];
        let views = [&t.scene.view, &t.light.view, &t.overlay.view, &t.scratch.view];
        // Index 4 tracks the normal target.
        let mut cleared = [false; 5];
        if let Some(mesh) = &mut self.mesh {
            cleared[0] = mesh.render(&self.device, &mut encoder, &t.scene.view, tw, th, clear_colors[0]);
        }
        let mut k = 0;
        while k < segments.len() {
            let target = segments[k].0;
            let seq = segments[k].4;
            let mut end = k;
            while end < segments.len() && segments[end].0 == target && segments[end].4 == seq {
                end += 1;
            }
            {
                let load = if target == 3 || !cleared[target] { wgpu::LoadOp::Clear(clear_colors[target]) } else { wgpu::LoadOp::Load };
                let mrt = target == 0 && normals_on;
                let mut attachments = vec![Some(wgpu::RenderPassColorAttachment { view: views[target], resolve_target: None, ops: wgpu::Operations { load, store: wgpu::StoreOp::Store } })];
                if mrt {
                    let nload = if cleared[4] { wgpu::LoadOp::Load } else { wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT) };
                    attachments.push(Some(wgpu::RenderPassColorAttachment { view: &t.normal.view, resolve_target: None, ops: wgpu::Operations { load: nload, store: wgpu::StoreOp::Store } }));
                }
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("sprites"),
                    color_attachments: &attachments,
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                cleared[target] = true;
                if mrt {
                    cleared[4] = true;
                }
                pass.set_pipeline(if mrt { &self.sprite_mrt_pipeline } else { &self.sprite_pipeline });
                pass.set_bind_group(0, &groups[target], &[]);
                pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                let (tw, th) = sizes[target];
                for &(_, first, count, sc, _) in &segments[k..end] {
                    match sc {
                        Some([x, y, w, h]) => {
                            let sx = tw as f32 / logical.0;
                            let sy = th as f32 / logical.1;
                            let px = ((x as f32 * sx) as u32).min(tw - 1);
                            let py = ((y as f32 * sy) as u32).min(th - 1);
                            let pw = ((w as f32 * sx).ceil() as u32).max(1).min(tw - px);
                            let ph = ((h as f32 * sy).ceil() as u32).max(1).min(th - py);
                            pass.set_scissor_rect(px, py, pw, ph);
                        }
                        None => pass.set_scissor_rect(0, 0, tw, th),
                    }
                    pass.set_vertex_buffer(0, self.vertex_buffer.slice((first as u64) * VERTEX_STRIDE..));
                    pass.draw_indexed(0..(count / 4) * 6, 0, 0..1);
                }
            }
            k = end;
        }
        for target in 0..5 {
            if cleared[target] {
                continue;
            }
            let (view, color) = match target {
                4 => (&t.normal.view, wgpu::Color::TRANSPARENT),
                1 => (views[1], wgpu::Color::WHITE),
                _ => (views[target], clear_colors[target]),
            };
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(color), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }

        // Fullscreen passes. Uniform slots are distinct per pass because writes land before the submit.
        let blank = &self.blank.1;
        let lin = &self.linear;
        let bloom = post[p::BLOOM];
        let passes_needed: Vec<(&wgpu::RenderPipeline, &wgpu::TextureView, [&wgpu::TextureView; 6], [&wgpu::Sampler; 6], Vec<f32>, Option<[f32; 4]>)> = {
            let mut list = Vec::new();
            fn six<'a>(a: &'a wgpu::TextureView, blank: &'a wgpu::TextureView) -> [&'a wgpu::TextureView; 6] { [a, blank, blank, blank, blank, blank] }
            let lins: [&wgpu::Sampler; 6] = [lin, lin, lin, lin, lin, lin];
            if bloom > 0.0 {
                list.push((&self.bright_pipeline, &t.bloom_a.view, six(&t.scene.view, blank), lins, vec![post[p::THRESHOLD], 0.0, 0.0, 0.0], None));
                let passes = (post[p::PASSES].round() as usize).max(1);
                for _ in 0..passes {
                    list.push((&self.blur_pipeline, &t.bloom_b.view, six(&t.bloom_a.view, blank), lins, vec![1.0 / t.bloom_a.w as f32, 0.0, 0.0, 0.0], None));
                    list.push((&self.blur_pipeline, &t.bloom_a.view, six(&t.bloom_b.view, blank), lins, vec![0.0, 1.0 / t.bloom_a.h as f32, 0.0, 0.0], None));
                }
                list.push((&self.copy_pipeline, &t.bloom_c.view, six(&t.bloom_a.view, blank), lins, vec![0.0; 4], None));
                for _ in 0..2 {
                    list.push((&self.blur_pipeline, &t.bloom_d.view, six(&t.bloom_c.view, blank), lins, vec![1.0 / t.bloom_c.w as f32, 0.0, 0.0, 0.0], None));
                    list.push((&self.blur_pipeline, &t.bloom_c.view, six(&t.bloom_d.view, blank), lins, vec![0.0, 1.0 / t.bloom_c.h as f32, 0.0, 0.0], None));
                }
            } else {
                list.push((&self.copy_pipeline, &t.bloom_a.view, six(blank, blank), lins, vec![0.0; 4], None));
                list.push((&self.copy_pipeline, &t.bloom_c.view, six(blank, blank), lins, vec![0.0; 4], None));
            }
            let exact = post[p::VIEW_W] as u32 == t.w && post[p::VIEW_H] as u32 == t.h;
            let edge = if exact { &self.nearest } else { lin };
            let comp = vec![
                bloom, if post[p::LIGHTING] > 0.5 && light_used { 1.0 } else { 0.0 }, post[p::USE_LUT], post[p::VIGNETTE],
                post[p::TINT_R], post[p::TINT_G], post[p::TINT_B], post[p::TINT_AMOUNT],
                post[p::SATURATION], post[p::CONTRAST], post[p::BRIGHTNESS], post[p::GRAIN],
                post[p::SCANLINES], (post[p::TARGET_H] / post[p::LOGICAL_H].max(1.0)).max(2.0), post[p::TIME], 0.0,
                post[p::OFFSET_X], post[p::OFFSET_Y], 0.0, 0.0,
            ];
            list.push((
                &self.composite_pipeline,
                &t.present.view,
                [&t.scene.view, &t.bloom_a.view, &t.bloom_c.view, &t.light.view, &t.overlay.view, lut],
                [edge, lin, lin, lin, edge, lin],
                comp,
                Some([post[p::VIEW_X], post[p::VIEW_Y], post[p::VIEW_W], post[p::VIEW_H]]),
            ));
            list
        };
        let mut offsets = Vec::with_capacity(passes_needed.len());
        for pass in &passes_needed {
            let mut data = pass.4.clone();
            data.resize(20, 0.0);
            let offset = self.uniform_slot * UNIFORM_SLOT;
            self.uniform_slot = (self.uniform_slot + 1) % UNIFORM_SLOTS;
            self.queue.write_buffer(&self.uniforms, offset, bytemuck::cast_slice(&data));
            offsets.push(offset);
        }
        let t = self.targets.as_ref().unwrap();
        for (n, (pipeline, view, textures, samplers, _, viewport)) in passes_needed.iter().enumerate() {
            let group = self.quad_group(offsets[n], *textures, *samplers);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("post"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if let Some([x, y, w, h]) = viewport {
                // A viewport outside the target is a validation panic in wgpu; keep it inside.
                let pw = t.present.w as f32;
                let ph = t.present.h as f32;
                let all_finite = [x, y, w, h].iter().all(|v| v.is_finite());
                let x = x.clamp(0.0, pw - 1.0);
                let y = y.clamp(0.0, ph - 1.0);
                let w = w.min(pw - x).max(1.0);
                let h = h.min(ph - y).max(1.0);
                if all_finite && w <= pw - x && h <= ph - y {
                    pass.set_viewport(x, y, w, h, 0.0, 1.0);
                }
            }
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..4, 0..1);
        }
        // Blit the presented frame to the window.
        {
            let group = self.quad_group(offsets[0], [&t.present.view, blank, blank, blank, blank, blank], [&self.nearest, lin, lin, lin, lin, lin]);
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &surface_view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.blit_pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..4, 0..1);
        }
        let mut readback: Option<(wgpu::Buffer, u32, u32, u32)> = None;
        if capture {
            let bytes_per_row = (t.present.w * 4 + 255) / 256 * 256;
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some("snapshot"), size: (bytes_per_row * t.present.h) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo { texture: &t.present.texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bytes_per_row), rows_per_image: Some(t.present.h) } },
                wgpu::Extent3d { width: t.present.w, height: t.present.h, depth_or_array_layers: 1 },
            );
            readback = Some((buffer, t.present.w, t.present.h, bytes_per_row));
        }
        self.queue.submit(Some(encoder.finish()));
        surface.present();
        self.frames += 1;
        if let Some((buffer, w, h, stride)) = readback {
            let slice = buffer.slice(..);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |r| {
                let _ = tx.send(r);
            });
            self.device.poll(wgpu::Maintain::Wait);
            if let Ok(Ok(())) = rx.recv() {
                let data = slice.get_mapped_range();
                let mut rgba = Vec::with_capacity((w * h * 4) as usize);
                for row in 0..h {
                    let start = (row * stride) as usize;
                    rgba.extend_from_slice(&data[start..start + (w * 4) as usize]);
                }
                drop(data);
                buffer.unmap();
                self.capture = Some((w, h, rgba));
            }
        }
        true
    }
}

fn rgb(c: u32) -> [f64; 3] {
    [((c >> 16) & 255) as f64 / 255.0, ((c >> 8) & 255) as f64 / 255.0, (c & 255) as f64 / 255.0]
}

fn is_emulated(info: &wgpu::AdapterInfo) -> bool {
    let name = info.name.to_lowercase();
    info.device_type == wgpu::DeviceType::Cpu || ["goldfish", "gfxstream", "swiftshader", "llvmpipe", "lavapipe", "microsoft basic render", "warp"].iter().any(|k| name.contains(k))
}

#[cfg(test)]
mod adapter_tests {
    use super::*;
    fn info(name: &str, kind: wgpu::DeviceType, backend: wgpu::Backend) -> wgpu::AdapterInfo {
        wgpu::AdapterInfo { name: name.into(), vendor: 0, device: 0, device_type: kind, driver: String::new(), driver_info: String::new(), backend }
    }
    #[test]
    fn software_is_rejected_independent_of_backend() {
        for backend in [wgpu::Backend::Metal, wgpu::Backend::Dx12, wgpu::Backend::Vulkan, wgpu::Backend::Gl] {
            assert!(is_emulated(&info("unknown CPU", wgpu::DeviceType::Cpu, backend)));
            for name in ["Google SwiftShader", "llvmpipe", "lavapipe", "Microsoft Basic Render Driver", "gfxstream"] {
                assert!(is_emulated(&info(name, wgpu::DeviceType::Other, backend)));
            }
        }
        assert!(!is_emulated(&info("Apple M1 Pro", wgpu::DeviceType::IntegratedGpu, wgpu::Backend::Metal)));
        assert!(!is_emulated(&info("NVIDIA GeForce", wgpu::DeviceType::DiscreteGpu, wgpu::Backend::Vulkan)));
    }
}

/// An instance, surface and adapter for `backends`, or None when no usable adapter exists.
fn pick_adapter(source: SurfaceSource, backends: wgpu::Backends, allow_emulated: bool) -> Option<(wgpu::Instance, wgpu::Surface<'static>, wgpu::Adapter)> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends,
        flags: wgpu::InstanceFlags::from_build_config() | wgpu::InstanceFlags::ALLOW_UNDERLYING_NONCOMPLIANT_ADAPTER,
        ..Default::default()
    });
    // The caller keeps the window or layer alive for as long as the renderer exists.
    let surface = unsafe { instance.create_surface_unsafe(source.target()) }.ok()?;
    let mut candidates: Vec<(i32, wgpu::Adapter)> = instance
        .enumerate_adapters(backends)
        .into_iter()
        .filter(|a| a.is_surface_supported(&surface))
        .filter_map(|a| {
            let info = a.get_info();
            let emulated = is_emulated(&info);
            if emulated && !allow_emulated {
                return None;
            }
            let score = match info.backend {
                wgpu::Backend::Metal | wgpu::Backend::Dx12 => 4,
                wgpu::Backend::Vulkan if !emulated => 3,
                wgpu::Backend::Gl => 2,
                wgpu::Backend::Vulkan => 1,
                _ => 0,
            } * 10
                + match info.device_type {
                    wgpu::DeviceType::DiscreteGpu => 3,
                    wgpu::DeviceType::IntegratedGpu => 2,
                    wgpu::DeviceType::VirtualGpu => 1,
                    _ => 0,
                };
            Some((score, a))
        })
        .collect();
    candidates.sort_by_key(|(score, _)| -*score);
    let adapter = candidates.into_iter().next().map(|(_, a)| a)?;
    Some((instance, surface, adapter))
}

// --- C ABI ---------------------------------------------------------------------------

/// A renderer on a `CAMetalLayer *`. Null when the pointer is null or no adapter exists.
///
/// # Safety
/// `layer` must be a live CAMetalLayer that outlives the renderer.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_new_metal_layer(layer: *mut std::ffi::c_void, width: u32, height: u32, max_quads: u32) -> *mut Renderer {
    if layer.is_null() {
        return std::ptr::null_mut();
    }
    match std::panic::catch_unwind(|| Renderer::new(SurfaceSource::MetalLayer(layer), width, height, max_quads.max(64) as usize)) {
        Ok(r) => Box::into_raw(Box::new(r)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `r` must come from a `kiln_render_new_*` call and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_free(r: *mut Renderer) {
    if !r.is_null() {
        drop(Box::from_raw(r));
    }
}

#[no_mangle]
pub extern "C" fn kiln_render_resize(r: *mut Renderer, width: u32, height: u32) {
    if let Some(r) = unsafe { r.as_mut() } {
        r.resize(width, height);
    }
}

/// # Safety
/// `rgba` must hold `width * height * 4` bytes.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_upload_texture(r: *mut Renderer, slot: u32, width: u32, height: u32, rgba: *const u8) {
    let Some(r) = r.as_mut() else { return };
    if rgba.is_null() || width == 0 || height == 0 {
        return;
    }
    let bytes = std::slice::from_raw_parts(rgba, (width * height * 4) as usize);
    r.upload_texture(slot as usize, width, height, bytes);
}

/// Draw one frame from the kernel's buffers. Returns 1 when presented, 0 when skipped.
///
/// # Safety
/// The pointers must hold `vertex_count * 10` floats, `command_count` words and `post_len` floats.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_frame(r: *mut Renderer, vertices: *const f32, vertex_count: u32, commands: *const u32, command_count: u32, post: *const f32, post_len: u32, capture: i32) -> i32 {
    let Some(r) = r.as_mut() else { return 0 };
    if vertices.is_null() || commands.is_null() || post.is_null() {
        return 0;
    }
    let frame = Frame {
        vertices: std::slice::from_raw_parts(vertices, vertex_count as usize * FLOATS_PER_VERT),
        vertex_count: vertex_count as usize,
        commands: std::slice::from_raw_parts(commands, command_count as usize),
        post: std::slice::from_raw_parts(post, post_len as usize),
    };
    r.render(frame, capture != 0) as i32
}

/// Size in bytes of the captured frame, and its dimensions; 0 when none is waiting.
///
/// # Safety
/// `width` and `height` may be null.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_capture_size(r: *mut Renderer, width: *mut u32, height: *mut u32) -> u32 {
    let Some(r) = r.as_ref() else { return 0 };
    let Some((w, h, rgba)) = &r.capture else { return 0 };
    if !width.is_null() {
        *width = *w;
    }
    if !height.is_null() {
        *height = *h;
    }
    rgba.len() as u32
}

/// Copy the captured frame out (RGBA, row by row) and clear it. Returns bytes copied.
///
/// # Safety
/// `out` must hold `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_capture_read(r: *mut Renderer, out: *mut u8, cap: u32) -> u32 {
    let Some(r) = r.as_mut() else { return 0 };
    let Some((_, _, rgba)) = r.capture.take() else { return 0 };
    if out.is_null() {
        return 0;
    }
    let n = rgba.len().min(cap as usize);
    std::ptr::copy_nonoverlapping(rgba.as_ptr(), out, n);
    n as u32
}

/// Submit version 1 mesh resources/frame. Returns 0 for malformed packets without changing the frame.
/// # Safety
/// bytes must contain len readable UTF-8 bytes; renderer must be live.
#[no_mangle]
pub unsafe extern "C" fn kiln_render_mesh(r: *mut Renderer, bytes: *const u8, len: u32) -> i32 {
    let Some(r) = r.as_mut() else { return 0 };
    if bytes.is_null() || len > 64 * 1024 * 1024 { return 0; }
    let Ok(json) = std::str::from_utf8(std::slice::from_raw_parts(bytes, len as usize)) else { return 0 };
    match r.submit_mesh(json) { Ok(()) => 1, Err(e) => { log::error!("mesh packet: {e}"); 0 } }
}

/// Retained mesh geometry count, texture count, or estimated mesh-stage GPU bytes.
#[no_mangle]
pub extern "C" fn kiln_render_mesh_resource(r: *const Renderer, index: u32) -> u64 {
    let Some(r) = (unsafe { r.as_ref() }) else { return 0 };
    let stats = r.mesh_resources();
    match index { 0 => stats.0 as u64, 1 => stats.1 as u64, 2 => stats.2 as u64, _ => 0 }
}

/// Merge unpresented frame resources while retaining only the final mesh list.
pub fn coalesce_mesh_packets(previous:&str,next:&str)->Result<String,String>{mesh::coalesce(previous,next)}
