use serde::{Deserialize,Serialize};
use std::collections::{HashMap, HashSet};
use wgpu::util::DeviceExt;

#[derive(Deserialize,Serialize)]
pub struct Packet {
    version: u32,
    geometries: Vec<GeometryData>,
    textures: Vec<TextureData>,
    meshes: Vec<MeshData>,
    #[serde(default)]
    shadows: bool,
    #[serde(default = "shadow_size", rename = "shadowSize")]
    shadow_size: u32,
}
fn shadow_size() -> u32 {
    1024
}
#[derive(Deserialize,Serialize)]
struct GeometryData {
    id: u32,
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
    indices: Vec<u32>,
}
#[derive(Deserialize,Serialize)]
struct TextureData {
    id: u32,
    width: u32,
    height: u32,
    data: Vec<u8>,
    filter: String,
    #[serde(default, rename = "minFilter")]
    min_filter: Option<String>,
    wrap: String,
    #[serde(default, rename = "wrapT")]
    wrap_t: Option<String>,
}
#[derive(Clone,Deserialize,Serialize)]
struct MeshData {
    geometry: u32,
    maps: [u32; 4],
    uniforms: Vec<f32>,
    blend: bool,
    shadow: bool,
    #[serde(default)]
    viewmodel: bool,
}
struct Geometry {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
    bytes: usize,
    index_data: Vec<u32>,
}
struct Texture {
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    bytes: usize,
}
struct Draw {
    geometry: u32,
    uniform: wgpu::Buffer,
    maps: [u32;4],
    viewmodel: bool,
    main: wgpu::BindGroup,
    depth: wgpu::BindGroup,
    blend: bool,
    shadow: bool,
    instances: Option<(wgpu::Buffer, u32, usize)>,
}
pub struct MeshStage {
    samples: u32,
    geometries: HashMap<u32, Geometry>,
    textures: HashMap<u32, Texture>,
    white: Texture,
    layout: wgpu::BindGroupLayout,
    depth_layout: wgpu::BindGroupLayout,
    opaque: wgpu::RenderPipeline,
    transparent: wgpu::RenderPipeline,
    shadow_pipeline: wgpu::RenderPipeline,
    instanced_opaque: wgpu::RenderPipeline,
    instanced_shadow: wgpu::RenderPipeline,
    depth: Option<(wgpu::Texture, wgpu::TextureView, u32, u32)>,
    msaa_color: Option<(wgpu::Texture, wgpu::TextureView, u32, u32)>,
    shadow: Option<(wgpu::Texture, wgpu::TextureView, u32)>,
    draws: Vec<Draw>,
    shadows: bool,
}
const INSTANCE_FLOATS: usize = 37;
fn same_batch(a: &MeshData, b: &MeshData) -> bool {
    if a.blend || b.blend || a.geometry != b.geometry || a.maps != b.maps || a.shadow != b.shadow || a.viewmodel != b.viewmodel {
        return false;
    }
    a.uniforms.iter().zip(&b.uniforms).enumerate().all(|(i, (x, y))| {
        (16..48).contains(&i) || (64..68).contains(&i) || i == 107 || x == y
    })
}
fn batch_meshes(meshes: Vec<MeshData>) -> Vec<Vec<MeshData>> {
    let mut groups: Vec<Vec<MeshData>> = Vec::new();
    for mesh in meshes {
        if let Some(group) = groups.last_mut() {
            if same_batch(&group[0], &mesh) {
                group.push(mesh);
                continue;
            }
        }
        groups.push(vec![mesh]);
    }
    groups
}
fn instance_data(group: &[MeshData]) -> Vec<f32> {
    let mut data = Vec::with_capacity(group.len() * INSTANCE_FLOATS);
    for mesh in group {
        data.extend_from_slice(&mesh.uniforms[16..48]);
        data.extend_from_slice(&mesh.uniforms[64..68]);
        data.push(mesh.uniforms[107]);
    }
    data
}
/// Preserve resource deltas when script submits multiple frames before the host presents.
pub fn coalesce(previous:&str,next:&str)->Result<String,String>{
    let old=Packet::parse(previous)?;let mut new=Packet::parse(next)?;
    let used_geometry:HashSet<_>=new.meshes.iter().map(|m|m.geometry).collect();
    let used_textures:HashSet<_>=new.meshes.iter().flat_map(|m|m.maps).collect();
    let replaced_geometry:HashSet<_>=new.geometries.iter().map(|g|g.id).collect();
    let replaced_textures:HashSet<_>=new.textures.iter().map(|t|t.id).collect();
    new.geometries.extend(old.geometries.into_iter().filter(|g|used_geometry.contains(&g.id)&&!replaced_geometry.contains(&g.id)));
    new.textures.extend(old.textures.into_iter().filter(|t|used_textures.contains(&t.id)&&!replaced_textures.contains(&t.id)));
    let json=serde_json::to_string(&new).map_err(|e|e.to_string())?;
    if json.len()>64*1024*1024{return Err("Pending mesh data too large".into());}
    Ok(json)
}
impl Packet {
    pub fn parse(json: &str) -> Result<Self, String> {
        if json.len() > 64 * 1024 * 1024 {
            return Err("3D packet too large".into());
        }
        let p: Self = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if p.version != 1 || p.meshes.len() > 100000 || !(128..=4096).contains(&p.shadow_size) {
            return Err("Invalid 3D protocol header".into());
        }
        for g in &p.geometries {
            if g.id == 0
                || g.positions.is_empty()
                || g.positions.len() % 3 != 0
                || g.positions.len() != g.normals.len()
                || g.uvs.len() != g.positions.len() / 3 * 2
                || g.indices.is_empty()
                || g.indices.len() % 3 != 0
                || g.indices
                    .iter()
                    .any(|i| *i as usize >= g.positions.len() / 3)
                || g.positions
                    .iter()
                    .chain(&g.normals)
                    .chain(&g.uvs)
                    .any(|v| !v.is_finite())
            {
                return Err("Invalid 3D geometry".into());
            }
        }
        for t in &p.textures {
            if t.id == 0
                || t.width == 0
                || t.height == 0
                || t.width > 8192
                || t.height > 8192
                || t.width as u64 * t.height as u64 * 4 != t.data.len() as u64
                || !matches!(t.filter.as_str(), "nearest" | "linear")
                || t.min_filter.as_deref().is_some_and(|mode| !matches!(mode,
                    "nearest" | "linear" | "nearest-mipmap-nearest" | "linear-mipmap-nearest" |
                    "nearest-mipmap-linear" | "linear-mipmap-linear"))
                || !matches!(t.wrap.as_str(), "repeat" | "clamp" | "mirror")
                || t.wrap_t.as_deref().is_some_and(|mode| !matches!(mode, "repeat" | "clamp" | "mirror"))
            {
                return Err("Invalid 3D texture".into());
            }
        }
        for m in &p.meshes {
            if m.uniforms.len() != 172 || m.uniforms.iter().any(|v| !v.is_finite()) {
                return Err("Invalid 3D uniforms".into());
            }
        }
        Ok(p)
    }
}
impl MeshStage {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, samples: u32) -> Self {
        assert!(samples == 1 || samples == 4);
        let uniform = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let texture = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let sampler = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let mut entries = vec![uniform];
        for i in 0..4 {
            entries.push(texture(1 + i * 2));
            entries.push(sampler(2 + i * 2));
        }
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 9,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Kiln mesh materials"),
            entries: &entries,
        });
        let depth_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Kiln mesh shadow"),
            entries: &entries[..3],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Kiln mesh shaders"),
            source: wgpu::ShaderSource::Wgsl(include_str!("mesh.wgsl").into()),
        });
        let pipeline = |blend: bool, depth: bool, instanced: bool| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: None,
                bind_group_layouts: &[if depth { &depth_layout } else { &layout }],
                push_constant_ranges: &[],
            });
            let targets = [Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: if blend {
                    Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)
                } else {
                    None
                },
                write_mask: wgpu::ColorWrites::ALL,
            })];
            let instance_attributes = wgpu::vertex_attr_array![
                3=>Float32x4, 4=>Float32x4, 5=>Float32x4, 6=>Float32x4,
                7=>Float32x4, 8=>Float32x4, 9=>Float32x4, 10=>Float32x4,
                11=>Float32x4, 12=>Float32
            ];
            let vertex_layout = wgpu::VertexBufferLayout { array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex, attributes: &wgpu::vertex_attr_array![0=>Float32x3,1=>Float32x3,2=>Float32x2] };
            let instance_layout = wgpu::VertexBufferLayout { array_stride: (INSTANCE_FLOATS * 4) as u64, step_mode: wgpu::VertexStepMode::Instance, attributes: &instance_attributes };
            let buffers = if instanced { vec![vertex_layout, instance_layout] } else { vec![vertex_layout] };
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor{
                label:Some("Kiln mesh pipeline"),layout:Some(&pl),
                vertex:wgpu::VertexState{module:&shader,entry_point:Some(match (depth,instanced) {(true,true)=>"depth_vs_instanced",(true,false)=>"depth_vs",(false,true)=>"vs_instanced",(false,false)=>"vs"}),compilation_options:Default::default(),buffers:&buffers},
                fragment:Some(wgpu::FragmentState{module:&shader,entry_point:Some(if depth{"depth_fs"}else{"fs"}),compilation_options:Default::default(),targets:if depth{&[]}else{&targets}}),
                primitive:wgpu::PrimitiveState{cull_mode:None,..Default::default()},
                depth_stencil:Some(wgpu::DepthStencilState{format:wgpu::TextureFormat::Depth32Float,depth_write_enabled:!blend,depth_compare:wgpu::CompareFunction::LessEqual,stencil:Default::default(),bias:if depth{wgpu::DepthBiasState{constant:2,slope_scale:1.5,clamp:0.0}}else{Default::default()}}),
                multisample:wgpu::MultisampleState{count:if depth{1}else{samples},..Default::default()},multiview:None,cache:None,
            })
        };
        let opaque = pipeline(false, false, false);
        let transparent = pipeline(true, false, false);
        let shadow_pipeline = pipeline(false, true, false);
        let instanced_opaque = pipeline(false, false, true);
        let instanced_shadow = pipeline(false, true, true);
        let white = Self::texture(
            device,
            queue,
            TextureData {
                id: 0,
                width: 1,
                height: 1,
                data: vec![255; 4],
                filter: "linear".into(),
                min_filter: None,
                wrap: "repeat".into(),
                wrap_t: None,
            },
        );
        Self {
            samples,
            geometries: HashMap::new(),
            textures: HashMap::new(),
            white,
            layout,
            depth_layout,
            opaque,
            transparent,
            shadow_pipeline,
            instanced_opaque,
            instanced_shadow,
            depth: None,
            msaa_color: None,
            shadow: None,
            draws: Vec::new(),
            shadows: false,
        }
    }
    fn texture(device: &wgpu::Device, queue: &wgpu::Queue, t: TextureData) -> Texture {
        let min_mode = t.min_filter.as_deref().unwrap_or(&t.filter);
        let has_mips = min_mode.contains("mipmap");
        let mut levels = 1;
        if has_mips {
            let (mut w, mut h) = (t.width, t.height);
            while w > 1 || h > 1 {
                w = (w / 2).max(1); h = (h / 2).max(1); levels += 1;
            }
        }
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Kiln mesh texture"),
            size: wgpu::Extent3d {
                width: t.width,
                height: t.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: levels,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let (mut width, mut height, mut pixels) = (t.width, t.height, t.data);
        let mut bytes = 0;
        for level in 0..levels {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                &pixels,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            bytes += pixels.len();
            if level + 1 < levels {
                let next_width = (width / 2).max(1);
                let next_height = (height / 2).max(1);
                let mut next = vec![0u8; (next_width * next_height * 4) as usize];
                for y in 0..next_height {
                    for x in 0..next_width {
                        for channel in 0..4 {
                            let mut sum = 0u32;
                            let mut samples = 0u32;
                            for sy in y * height / next_height..(y + 1) * height / next_height {
                                for sx in x * width / next_width..(x + 1) * width / next_width {
                                    sum += pixels[((sy * width + sx) * 4 + channel) as usize] as u32;
                                    samples += 1;
                                }
                            }
                            next[((y * next_width + x) * 4 + channel) as usize] = ((sum + samples / 2) / samples) as u8;
                        }
                    }
                }
                pixels = next; width = next_width; height = next_height;
            }
        }
        let filter = if t.filter == "nearest" {
            wgpu::FilterMode::Nearest
        } else {
            wgpu::FilterMode::Linear
        };
        let address_mode = |wrap: &str| match wrap {
            "clamp" => wgpu::AddressMode::ClampToEdge,
            "mirror" => wgpu::AddressMode::MirrorRepeat,
            _ => wgpu::AddressMode::Repeat,
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: filter,
            min_filter: if min_mode.starts_with("nearest") { wgpu::FilterMode::Nearest } else { wgpu::FilterMode::Linear },
            mipmap_filter: if matches!(min_mode, "nearest-mipmap-linear" | "linear-mipmap-linear") { wgpu::FilterMode::Linear } else { wgpu::FilterMode::Nearest },
            address_mode_u: address_mode(&t.wrap),
            address_mode_v: address_mode(t.wrap_t.as_deref().unwrap_or(&t.wrap)),
            ..Default::default()
        });
        let view = texture.create_view(&Default::default());
        Texture {
            _texture: texture,
            view,
            sampler,
            bytes,
        }
    }
    fn depth_texture(device: &wgpu::Device, w: u32, h: u32, samples: u32) -> (wgpu::Texture, wgpu::TextureView) {
        let t = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Kiln mesh depth"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | if samples == 1 { wgpu::TextureUsages::TEXTURE_BINDING } else { wgpu::TextureUsages::empty() },
            view_formats: &[],
        });
        let v = t.create_view(&Default::default());
        (t, v)
    }
    pub fn submit(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        p: Packet,
    ) -> Result<(), String> {
        // Validate all references before mutating retained state.
        let geometry_ids: HashSet<_> = self
            .geometries
            .keys()
            .copied()
            .chain(p.geometries.iter().map(|g| g.id))
            .collect();
        let texture_ids: HashSet<_> = self
            .textures
            .keys()
            .copied()
            .chain(p.textures.iter().map(|t| t.id))
            .collect();
        for m in &p.meshes {
            if !geometry_ids.contains(&m.geometry)
                || m.maps
                    .iter()
                    .any(|id| *id != 0 && !texture_ids.contains(id))
            {
                return Err("Missing mesh resource".into());
            }
        }
        let shadow_changed = self.shadow.as_ref().map(|s| s.2) != Some(p.shadow_size);
        if shadow_changed {
            let (t, v) = Self::depth_texture(device, p.shadow_size, p.shadow_size, 1);
            self.shadow = Some((t, v, p.shadow_size));
        }
        let mut previous = std::mem::take(&mut self.draws).into_iter();
        let changed_textures: HashSet<_> = p.textures.iter().map(|t| t.id).collect();
        self.shadows = p.shadows;
        for g in p.geometries {
            let mut data = Vec::with_capacity(g.positions.len() / 3 * 8);
            for i in 0..g.positions.len() / 3 {
                data.extend_from_slice(&g.positions[i * 3..i * 3 + 3]);
                data.extend_from_slice(&g.normals[i * 3..i * 3 + 3]);
                data.extend_from_slice(&g.uvs[i * 2..i * 2 + 2]);
            }
            if let Some(existing) = self.geometries.get_mut(&g.id) {
                if existing.vertices.size() == (data.len()*4) as u64 && existing.indices.size() == (g.indices.len()*4) as u64 {
                    queue.write_buffer(&existing.vertices,0,bytemuck::cast_slice(&data));
                    if existing.index_data != g.indices {
                        queue.write_buffer(&existing.indices,0,bytemuck::cast_slice(&g.indices));
                        existing.index_data=g.indices;
                    }
                    continue;
                }
            }
            let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh vertices"),
                contents: bytemuck::cast_slice(&data),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            });
            let indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh indices"),
                contents: bytemuck::cast_slice(&g.indices),
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            });
            self.geometries.insert(
                g.id,
                Geometry {
                    vertices,
                    indices,
                    count: g.indices.len() as u32,
                    bytes: data.len() * 4 + g.indices.len() * 4,
                    index_data:g.indices,
                },
            );
        }
        for t in p.textures {
            self.textures.insert(t.id, Self::texture(device, queue, t));
        }
        let mut used_geometry = HashSet::new();
        let mut used_textures = HashSet::new();
        for group in batch_meshes(p.meshes) {
            let m = &group[0];
            let instance_values = (group.len() > 1).then(|| instance_data(&group));
            used_geometry.insert(m.geometry);
            for id in m.maps {
                used_textures.insert(id);
            }
            if let Some(mut draw) = previous.next() {
                if draw.maps == m.maps && draw.instances.is_some() == instance_values.is_some() && !shadow_changed && !m.maps.iter().any(|id| changed_textures.contains(id)) {
                    queue.write_buffer(&draw.uniform,0,bytemuck::cast_slice(&m.uniforms));
                    if let (Some(values), Some((buffer, count, capacity))) = (instance_values.as_ref(), draw.instances.as_mut()) {
                        let bytes = bytemuck::cast_slice(values);
                        if bytes.len() <= *capacity {
                            queue.write_buffer(buffer, 0, bytes);
                        } else {
                            *buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("mesh instances"), contents: bytes,
                                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                            });
                            *capacity = bytes.len();
                        }
                        *count = group.len() as u32;
                    }
                    draw.geometry=m.geometry;draw.blend=m.blend;draw.shadow=m.shadow;draw.viewmodel=m.viewmodel;
                    self.draws.push(draw);
                    continue;
                }
            }
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("mesh uniforms"),
                contents: bytemuck::cast_slice(&m.uniforms),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let mut entries = vec![wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }];
            for (i, id) in m.maps.iter().enumerate() {
                let t = self.textures.get(id).unwrap_or(&self.white);
                entries.push(wgpu::BindGroupEntry {
                    binding: 1 + i as u32 * 2,
                    resource: wgpu::BindingResource::TextureView(&t.view),
                });
                entries.push(wgpu::BindGroupEntry {
                    binding: 2 + i as u32 * 2,
                    resource: wgpu::BindingResource::Sampler(&t.sampler),
                });
            }
            let depth = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.depth_layout,
                entries: &entries[..3],
            });
            entries.push(wgpu::BindGroupEntry {
                binding: 9,
                resource: wgpu::BindingResource::TextureView(&self.shadow.as_ref().unwrap().1),
            });
            let main = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.layout,
                entries: &entries,
            });
            self.draws.push(Draw {
                geometry: m.geometry,
                uniform,
                maps:m.maps,
                main,
                depth,
                blend: m.blend,
                shadow: m.shadow,
                viewmodel:m.viewmodel,
                instances: instance_values.map(|values| {
                    let bytes = bytemuck::cast_slice(&values);
                    (device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("mesh instances"), contents: bytes,
                        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    }), group.len() as u32, bytes.len())
                }),
            });
        }
        self.geometries.retain(|id, _| used_geometry.contains(id));
        self.textures.retain(|id, _| used_textures.contains(id));
        Ok(())
    }
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        w: u32,
        h: u32,
        clear: wgpu::Color,
    ) -> bool {
        if self.draws.is_empty() {
            return false;
        }
        if self.depth.as_ref().map(|d| (d.2, d.3)) != Some((w, h)) {
            let (t, v) = Self::depth_texture(device, w, h, self.samples);
            self.depth = Some((t, v, w, h));
        }
        if self.samples > 1 && self.msaa_color.as_ref().map(|t| (t.2, t.3)) != Some((w, h)) {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Kiln mesh MSAA color"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: self.samples,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            self.msaa_color = Some((texture, view, w, h));
        }
        if self.shadows {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("mesh shadows"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.shadow.as_ref().unwrap().1,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            for d in &self.draws {
                if !d.shadow || d.viewmodel {
                    continue;
                }
                let g = &self.geometries[&d.geometry];
                pass.set_pipeline(if d.instances.is_some() { &self.instanced_shadow } else { &self.shadow_pipeline });
                pass.set_bind_group(0, &d.depth, &[]);
                pass.set_vertex_buffer(0, g.vertices.slice(..));
                if let Some((buffer, _, _)) = &d.instances { pass.set_vertex_buffer(1, buffer.slice(..)); }
                pass.set_index_buffer(g.indices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..g.count, 0, 0..d.instances.as_ref().map(|i| i.1).unwrap_or(1));
            }
        }
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("mesh world"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: self.msaa_color.as_ref().map(|t| &t.1).unwrap_or(target),
                resolve_target: if self.samples > 1 { Some(target) } else { None },
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(clear),
                    store: if self.samples > 1 { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &self.depth.as_ref().unwrap().1,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        for viewmodel in [false,true] {
        pass.set_viewport(0.0,0.0,w as f32,h as f32,if viewmodel{0.0}else{0.02},if viewmodel{0.02}else{1.0});
        for d in self.draws.iter().filter(|d| d.viewmodel == viewmodel) {
            let g = &self.geometries[&d.geometry];
            pass.set_pipeline(if d.instances.is_some() {
                &self.instanced_opaque
            } else if d.blend {
                &self.transparent
            } else {
                &self.opaque
            });
            pass.set_bind_group(0, &d.main, &[]);
            pass.set_vertex_buffer(0, g.vertices.slice(..));
            if let Some((buffer, _, _)) = &d.instances { pass.set_vertex_buffer(1, buffer.slice(..)); }
            pass.set_index_buffer(g.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..g.count, 0, 0..d.instances.as_ref().map(|i| i.1).unwrap_or(1));
        }
        }
        true
    }
    pub fn resources(&self) -> (usize, usize, usize) {
        (
            self.geometries.len(),
            self.textures.len(),
            self.geometries.values().map(|g| g.bytes).sum::<usize>()
                + self.textures.values().map(|t| t.bytes).sum::<usize>()
                + self.draws.len() * 688
                + self.draws.iter().filter_map(|d| d.instances.as_ref().map(|i| i.2)).sum::<usize>()
                + self
                    .depth
                    .as_ref()
                    .map(|d| (d.2 as usize) * (d.3 as usize) * 4 * self.samples as usize)
                    .unwrap_or(0)
                + self.msaa_color.as_ref().map(|t| t.2 as usize * t.3 as usize * 4 * self.samples as usize).unwrap_or(0)
                + self
                    .shadow
                    .as_ref()
                    .map(|s| (s.2 as usize).pow(2) * 4)
                    .unwrap_or(0),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires a GPU adapter; exercised explicitly by native validation"]
    fn retained_buffers_and_bind_groups_survive_repeated_submissions() {
        let instance=wgpu::Instance::default();
        let adapter=pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("GPU adapter required");
        let (device,queue)=pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default(),None)).unwrap();
        let mut stage=MeshStage::new(&device,&queue,1);
        let packet=||Packet {version:1,geometries:vec![GeometryData{id:1,positions:vec![0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0,0.0],normals:vec![0.0;9],uvs:vec![0.0;6],indices:vec![0,1,2]}],textures:vec![],meshes:vec![MeshData{geometry:1,maps:[0;4],uniforms:vec![0.0;172],blend:false,shadow:true,viewmodel:false}],shadows:true,shadow_size:128};
        stage.submit(&device,&queue,packet()).unwrap();
        let uniform=stage.draws[0].uniform.clone();let bind=stage.draws[0].main.clone();let vertex=stage.geometries[&1].vertices.clone();
        for _ in 0..120 { stage.submit(&device,&queue,packet()).unwrap(); }
        assert_eq!(stage.draws[0].uniform,uniform);assert_eq!(stage.draws[0].main,bind);assert_eq!(stage.geometries[&1].vertices,vertex);
        let mut changed=packet();changed.shadow_size=256;stage.submit(&device,&queue,changed).unwrap();
        assert_ne!(stage.draws[0].main,bind,"shadow replacement must rebind its texture view");
        let mut empty=packet();empty.meshes.clear();empty.geometries.clear();stage.submit(&device,&queue,empty).unwrap();
        assert!(stage.draws.is_empty());assert_eq!(stage.resources().0,0);
        queue.submit([]);device.poll(wgpu::Maintain::Wait);
    }
    #[test]
    #[ignore = "requires a GPU adapter with 4x MSAA; exercised explicitly by native validation"]
    fn four_sample_mesh_resolves_antialiased_edges() {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("GPU adapter required");
        let color = adapter.get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm).flags;
        let depth = adapter.get_texture_format_features(wgpu::TextureFormat::Depth32Float).flags;
        assert!(color.contains(wgpu::TextureFormatFeatureFlags::MULTISAMPLE_X4 | wgpu::TextureFormatFeatureFlags::MULTISAMPLE_RESOLVE));
        assert!(depth.contains(wgpu::TextureFormatFeatureFlags::MULTISAMPLE_X4));
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default(), None)).unwrap();
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut stage = MeshStage::new(&device, &queue, 4);
        let mut uniforms = vec![0.0; 172];
        for offset in [0, 16, 32, 48] { for diagonal in 0..4 { uniforms[offset + diagonal * 5] = 1.0; } }
        uniforms[64..67].fill(1.0);
        uniforms[67] = 1.0;
        uniforms[70] = 2.0; // Unlit material.
        uniforms[75] = -1.0; // No alpha cutout.
        stage.submit(&device, &queue, Packet {
            version: 1,
            geometries: vec![GeometryData {
                id: 1,
                positions: vec![-0.8, -0.8, 0.0, 0.8, -0.8, 0.0, 0.0, 0.8, 0.0],
                normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                uvs: vec![0.0; 6],
                indices: vec![0, 1, 2],
            }],
            textures: vec![],
            meshes: vec![MeshData { geometry: 1, maps: [0; 4], uniforms, blend: false, shadow: false, viewmodel: false }],
            shadows: false,
            shadow_size: 128,
        }).unwrap();
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("MSAA test resolve target"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("MSAA test") });
        assert!(stage.render(&device, &mut encoder, &view, 64, 64, wgpu::Color::BLACK));
        assert_eq!(stage.msaa_color.as_ref().unwrap().0.sample_count(), 4);
        assert_eq!(stage.depth.as_ref().unwrap().0.sample_count(), 4);
        assert_eq!(stage.shadow.as_ref().unwrap().0.sample_count(), 1);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("MSAA test readback"), size: 64 * 64 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(64) } },
            wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
        );
        queue.submit(Some(encoder.finish()));
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| { let _ = tx.send(result); });
        device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let pixels = slice.get_mapped_range();
        assert!(pixels.chunks_exact(4).any(|pixel| pixel[0] > 0 && pixel[0] < 255), "resolved triangle should have partial-coverage edge pixels");
        drop(pixels);
        readback.unmap();
        assert!(pollster::block_on(device.pop_error_scope()).is_none(), "MSAA pass must not trigger GPU validation errors");
    }
    #[test]
    #[ignore = "requires a GPU adapter; exercised explicitly by native validation"]
    fn repeated_meshes_share_native_draw_and_preserve_instance_colors() {
        let instance = wgpu::Instance::default();
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).expect("GPU adapter required");
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default(), None)).unwrap();
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut stage = MeshStage::new(&device, &queue, 1);
        let mut first = vec![0.0; 172];
        for offset in [0, 16, 32, 48] { for diagonal in 0..4 { first[offset + diagonal * 5] = 1.0; } }
        first[28] = -0.5;
        first[64] = 1.0; first[67] = 1.0;
        first[70] = 2.0; first[75] = -1.0; first[106] = 1.0;
        let mut second = first.clone();
        second[28] = 0.5;
        second[64] = 0.0; second[65] = 1.0;
        stage.submit(&device, &queue, Packet {
            version: 1,
            geometries: vec![GeometryData {
                id: 1,
                positions: vec![-0.25, -0.25, 0.0, 0.25, -0.25, 0.0, 0.0, 0.25, 0.0],
                normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                uvs: vec![0.0; 6], indices: vec![0, 1, 2],
            }],
            textures: vec![],
            meshes: vec![first, second].into_iter().map(|uniforms| MeshData {
                geometry: 1, maps: [0; 4], uniforms, blend: false, shadow: true, viewmodel: false,
            }).collect(),
            shadows: true, shadow_size: 128,
        }).unwrap();
        assert_eq!(stage.draws.len(), 1);
        assert_eq!(stage.draws[0].instances.as_ref().unwrap().1, 2);
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("instancing readback target"),
            size: wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("instancing test") });
        assert!(stage.render(&device, &mut encoder, &view, 64, 64, wgpu::Color::BLACK));
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("instancing readback"), size: 64 * 64 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &target, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &readback, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(64) } },
            wgpu::Extent3d { width: 64, height: 64, depth_or_array_layers: 1 },
        );
        queue.submit(Some(encoder.finish()));
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| { let _ = tx.send(result); });
        device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let pixels = slice.get_mapped_range();
        let left = &pixels[(32 * 64 + 16) * 4..(32 * 64 + 16) * 4 + 4];
        let right = &pixels[(32 * 64 + 48) * 4..(32 * 64 + 48) * 4 + 4];
        assert!(left[0] > left[1] * 2 && left[0] > 100, "first instance should be red: {left:?}");
        assert!(right[1] > right[0] * 2 && right[1] > 100, "second instance should be green: {right:?}");
        drop(pixels); readback.unmap();
        let mip = MeshStage::texture(&device, &queue, TextureData {
            id: 2, width: 3, height: 3, data: vec![128; 36], filter: "linear".into(),
            min_filter: Some("linear-mipmap-linear".into()), wrap: "repeat".into(), wrap_t: None,
        });
        assert_eq!(mip._texture.mip_level_count(), 2);
        assert_eq!(mip.bytes, 40);
        assert!(pollster::block_on(device.pop_error_scope()).is_none());
    }
    #[test]
    fn coalescing_retains_referenced_pending_resources_only() {
        let first=r#"{"version":1,"geometries":[{"id":1,"positions":[0,0,0,1,0,0,0,1,0],"normals":[0,0,1,0,0,1,0,0,1],"uvs":[0,0,1,0,0,1],"indices":[0,1,2]}],"textures":[],"meshes":[]}"#;
        let next=serde_json::json!({"version":1,"geometries":[],"textures":[],"meshes":[{"geometry":1,"maps":[0,0,0,0],"uniforms":vec![0;172],"blend":false,"shadow":false}]}).to_string();
        let merged=Packet::parse(&coalesce(first,&next).unwrap()).unwrap();
        assert_eq!(merged.geometries.len(),1);assert_eq!(merged.meshes.len(),1);
        let empty=r#"{"version":1,"geometries":[],"textures":[],"meshes":[]}"#;
        assert!(Packet::parse(&coalesce(first,empty).unwrap()).unwrap().geometries.is_empty());
    }
    #[test]
    fn packet_rejects_wrong_version_and_invalid_geometry() {
        assert!(
            Packet::parse(r#"{"version":2,"geometries":[],"textures":[],"meshes":[]}"#).is_err()
        );
        assert!(Packet::parse(r#"{"version":1,"geometries":[{"id":1,"positions":[0,0,0],"normals":[0,1,0],"uvs":[0,0],"indices":[0,1,2]}],"textures":[],"meshes":[]}"#).is_err());
        assert!(
            Packet::parse(r#"{"version":1,"geometries":[],"textures":[],"meshes":[]}"#).is_ok()
        );
    }
    #[test]
    fn texture_packet_accepts_independent_wrap_and_rejects_invalid_modes() {
        let mut packet = serde_json::json!({
            "version": 1, "geometries": [], "meshes": [],
            "textures": [{"id": 1, "width": 1, "height": 1, "data": [255, 255, 255, 255],
                "filter": "linear", "wrap": "clamp", "wrapT": "mirror"}]
        });
        assert!(Packet::parse(&packet.to_string()).is_ok());
        packet["textures"][0].as_object_mut().unwrap().remove("wrapT");
        assert!(Packet::parse(&packet.to_string()).is_ok(), "old packets use U wrap for V");
        packet["textures"][0]["wrapT"] = "invalid".into();
        assert!(Packet::parse(&packet.to_string()).is_err());
        packet["textures"][0]["wrapT"] = "repeat".into();
        packet["textures"][0]["filter"] = "invalid".into();
        assert!(Packet::parse(&packet.to_string()).is_err());
        packet["textures"][0]["filter"] = "linear".into();
        packet["textures"][0]["minFilter"] = "linear-mipmap-linear".into();
        assert!(Packet::parse(&packet.to_string()).is_ok());
        packet["textures"][0]["minFilter"] = "invalid".into();
        assert!(Packet::parse(&packet.to_string()).is_err());
    }
}
