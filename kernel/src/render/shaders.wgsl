// Kiln's render passes in WGSL: the same maths as the WebGL2 and Metal shaders.

struct SpriteUniforms { viewport: vec2<f32>, target_size: vec2<f32> };
@group(0) @binding(0) var<uniform> su: SpriteUniforms;
// The atlas is bound twice: OpenGL backends need one sampler per texture binding.
@group(0) @binding(1) var atlas_nearest: texture_2d<f32>;
@group(0) @binding(2) var atlas_linear: texture_2d<f32>;
@group(0) @binding(3) var glyphs: texture_2d<f32>;
@group(0) @binding(4) var nearest: sampler;
@group(0) @binding(5) var linear: sampler;
@group(0) @binding(6) var normals_atlas: texture_2d<f32>;
@group(0) @binding(7) var normal_buf: texture_2d<f32>;
@group(0) @binding(8) var scratch: texture_2d<f32>;

struct SpriteIn {
  @location(0) pos: vec2<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) flags: vec2<f32>,
  @location(4) extra: vec2<f32>,
};

struct SpriteOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) flags: vec2<f32>,
  @location(3) extra: vec2<f32>,
};

@vertex fn sprite_vertex(in: SpriteIn) -> SpriteOut {
  var out: SpriteOut;
  out.position = vec4<f32>(in.pos.x / su.viewport.x * 2.0 - 1.0, 1.0 - in.pos.y / su.viewport.y * 2.0, 0.0, 1.0);
  out.uv = in.uv;
  out.color = in.color;
  out.flags = in.flags;
  out.extra = in.extra;
  return out;
}

struct Shaded { color: vec4<f32>, normal: vec4<f32> };

fn hash21s(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453); }

// flags.x is blend (bits 0-1) plus 4 * material; flags.y the texture slot; extra the material's
// parameters or a light's height and falloff. Output is premultiplied; additive draws carry no
// coverage; erase draws multiply the target by 1 - alpha.
fn shade(in: SpriteOut) -> Shaded {
  var out: Shaded;
  let mode = i32(in.flags.x + 0.5);
  let blend = mode & 3;
  let material = mode >> 2u;
  let slot = i32(in.flags.y + 0.5);
  var n = vec4<f32>(0.0);
  var rgb = vec3<f32>(0.0);
  var a = 0.0;
  if (slot == 3) {
    let d = length(in.uv);
    let atten = pow(clamp(1.0 - d, 0.0, 1.0), max(in.extra.y, 0.01));
    var lit = 1.0;
    let nb = textureSampleLevel(normal_buf, linear, in.position.xy / su.target_size, 0.0);
    if (nb.a > 0.01) {
      var nrm = normalize(nb.rgb / nb.a * 2.0 - 1.0);
      nrm.y = -nrm.y;
      let l = normalize(vec3<f32>(-in.uv.x, -in.uv.y, max(in.extra.x, 0.05)));
      lit = mix(0.15, 1.15, clamp(dot(nrm, l), 0.0, 1.0));
    }
    rgb = in.color.rgb;
    a = atten * lit * in.color.a;
  } else if (slot == 4) {
    let sc = textureSampleLevel(scratch, linear, in.position.xy / su.target_size, 0.0);
    out.color = vec4<f32>(sc.rgb * in.color.a, 0.0);
    out.normal = vec4<f32>(0.0);
    return out;
  } else {
    var t: vec4<f32>;
    if (slot == 0) {
      t = textureSampleLevel(atlas_nearest, nearest, in.uv, 0.0);
      n = textureSampleLevel(normals_atlas, nearest, in.uv, 0.0);
    } else if (slot == 1) {
      t = textureSampleLevel(atlas_linear, linear, in.uv, 0.0);
      n = textureSampleLevel(normals_atlas, nearest, in.uv, 0.0);
    } else {
      t = vec4<f32>(1.0, 1.0, 1.0, textureSampleLevel(glyphs, linear, in.uv, 0.0).a);
    }
    rgb = t.rgb * in.color.rgb;
    a = t.a;
    if (material == 1) {
      rgb = mix(rgb, vec3<f32>(1.0), in.extra.x);
    } else if (material == 2) {
      let h = hash21s(floor(in.uv * 4096.0));
      if (h < in.extra.x) { a = 0.0; }
      else if (h < in.extra.x + in.extra.y) { rgb = in.color.rgb; }
    } else if (material == 3) {
      if (t.a < 0.5) {
        let near = textureSampleLevel(atlas_nearest, nearest, in.uv + vec2<f32>(in.extra.x, 0.0), 0.0).a
                 + textureSampleLevel(atlas_nearest, nearest, in.uv - vec2<f32>(in.extra.x, 0.0), 0.0).a
                 + textureSampleLevel(atlas_nearest, nearest, in.uv + vec2<f32>(0.0, in.extra.y), 0.0).a
                 + textureSampleLevel(atlas_nearest, nearest, in.uv - vec2<f32>(0.0, in.extra.y), 0.0).a;
        if (near > 0.5) { rgb = in.color.rgb; a = 1.0; } else { a = 0.0; }
      } else {
        rgb = t.rgb;
      }
    } else if (material == 4) {
      rgb = in.color.rgb;
    }
    a = a * in.color.a;
  }
  if (blend == 2) {
    out.color = vec4<f32>(0.0, 0.0, 0.0, a);
    out.normal = vec4<f32>(0.0);
    return out;
  }
  let keep = select(1.0, 0.0, blend == 1);
  out.color = vec4<f32>(rgb * a, a * keep);
  let cov = step(0.5, a) * n.a * keep;
  out.normal = vec4<f32>(n.rgb * cov, cov);
  return out;
}

@fragment fn sprite_fragment(in: SpriteOut) -> @location(0) vec4<f32> {
  return shade(in).color;
}

struct MrtOut { @location(0) color: vec4<f32>, @location(1) normal: vec4<f32> };

@fragment fn sprite_fragment_mrt(in: SpriteOut) -> MrtOut {
  let s = shade(in);
  var o: MrtOut;
  o.color = s.color;
  o.normal = s.normal;
  return o;
}

struct QuadOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn quad_vertex(@builtin(vertex_index) vid: u32) -> QuadOut {
  var pos = array<vec2<f32>, 4>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0));
  let p = pos[vid];
  var out: QuadOut;
  out.position = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

// One uniform block for every fullscreen pass; each pass reads the fields it needs.
struct PostUniforms {
  a: vec4<f32>,      // bright: threshold; blur: dir.xy; composite: bloomStrength, lighting, useLut, vignette
  tint: vec4<f32>,   // tint.rgb, tintAmount
  b: vec4<f32>,      // saturation, contrast, brightness, grain
  c: vec4<f32>,      // scanlines, scanPeriod, time, pad
  offset: vec4<f32>, // offset.xy
};
@group(0) @binding(0) var<uniform> pu: PostUniforms;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
@group(0) @binding(5) var t4: texture_2d<f32>;
@group(0) @binding(6) var t5: texture_2d<f32>;
@group(0) @binding(7) var s0: sampler;
@group(0) @binding(8) var s1: sampler;
@group(0) @binding(9) var s2: sampler;
@group(0) @binding(10) var s3: sampler;
@group(0) @binding(11) var s4: sampler;
@group(0) @binding(12) var s5: sampler;

@fragment fn bright_fragment(in: QuadOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(t0, s0, in.uv, 0.0).rgb;
  let l = max(c.r, max(c.g, c.b));
  let threshold = pu.a.x;
  let knee = 0.15;
  var soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  let w = max(soft, l - threshold) / max(l, 1e-4);
  return vec4<f32>(c * w, 1.0);
}

@fragment fn blur_fragment(in: QuadOut) -> @location(0) vec4<f32> {
  let dir = pu.a.xy;
  let w0 = 0.227027; let w1 = 0.1945946; let w2 = 0.1216216; let w3 = 0.054054; let w4 = 0.016216;
  var c = textureSampleLevel(t0, s0, in.uv, 0.0).rgb * w0;
  c += textureSampleLevel(t0, s0, in.uv + dir * 1.0, 0.0).rgb * w1 + textureSampleLevel(t0, s0, in.uv - dir * 1.0, 0.0).rgb * w1;
  c += textureSampleLevel(t0, s0, in.uv + dir * 2.0, 0.0).rgb * w2 + textureSampleLevel(t0, s0, in.uv - dir * 2.0, 0.0).rgb * w2;
  c += textureSampleLevel(t0, s0, in.uv + dir * 3.0, 0.0).rgb * w3 + textureSampleLevel(t0, s0, in.uv - dir * 3.0, 0.0).rgb * w3;
  c += textureSampleLevel(t0, s0, in.uv + dir * 4.0, 0.0).rgb * w4 + textureSampleLevel(t0, s0, in.uv - dir * 4.0, 0.0).rgb * w4;
  return vec4<f32>(c, 1.0);
}

@fragment fn copy_fragment(in: QuadOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSampleLevel(t0, s0, in.uv, 0.0).rgb, 1.0);
}

fn hash21(p: vec2<f32>) -> f32 { return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453); }

@fragment fn composite_fragment(in: QuadOut) -> @location(0) vec4<f32> {
  let bloomStrength = pu.a.x;
  let lighting = pu.a.y;
  let useLut = pu.a.z;
  let vignette = pu.a.w;
  let uv = clamp(in.uv - pu.offset.xy, vec2<f32>(0.0), vec2<f32>(1.0));
  var c = textureSampleLevel(t0, s0, uv, 0.0).rgb;
  if (lighting > 0.5) { c *= textureSampleLevel(t3, s3, uv, 0.0).rgb; }
  c += (textureSampleLevel(t1, s1, uv, 0.0).rgb * 0.65 + textureSampleLevel(t2, s2, uv, 0.0).rgb * 0.55) * bloomStrength;
  let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  c = mix(vec3<f32>(l), c, pu.b.x);
  c = (c - 0.5) * pu.b.y + 0.5;
  c *= pu.b.z;
  c = mix(c, c * pu.tint.rgb, pu.tint.w);
  if (useLut > 0.5) {
    c = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    c = vec3<f32>(textureSampleLevel(t5, s5, vec2<f32>(c.r, 0.5), 0.0).r, textureSampleLevel(t5, s5, vec2<f32>(c.g, 0.5), 0.0).g, textureSampleLevel(t5, s5, vec2<f32>(c.b, 0.5), 0.0).b);
  }
  let d = (in.uv - 0.5) * vec2<f32>(1.15, 1.0);
  let v = smoothstep(0.35, 0.95, length(d) * 1.3);
  c *= 1.0 - v * vignette;
  let grain = pu.b.w;
  if (grain > 0.0) { c += (hash21(in.position.xy + fract(pu.c.z) * 1000.0) - 0.5) * grain; }
  let scanlines = pu.c.x;
  if (scanlines > 0.0) { c *= 1.0 - scanlines * 0.5 * (1.0 + sin(in.position.y / pu.c.y * 6.2831853)); }
  let o = textureSampleLevel(t4, s4, in.uv, 0.0);
  c = o.rgb + c * (1.0 - o.a);
  return vec4<f32>(c, 1.0);
}
