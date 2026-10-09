// GLSL ES 3.00 sources for the WebGL2 backend.

export const SPRITE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in vec4 aColor;
layout(location = 3) in vec2 aFlags; // x: blend + 4 * material, y: slot (0 atlas nearest, 1 atlas linear, 2 glyphs, 3 light, 4 scratch)
layout(location = 4) in vec2 aExtra; // material parameters, or a light's height and falloff
uniform vec2 uViewport;
out vec2 vUV;
out vec4 vColor;
out vec2 vFlags;
out vec2 vExtra;
void main() {
  vUV = aUV;
  vColor = aColor;
  vFlags = aFlags;
  vExtra = aExtra;
  vec2 clip = vec2(aPos.x / uViewport.x * 2.0 - 1.0, 1.0 - aPos.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

export const SPRITE_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
in vec4 vColor;
in vec2 vFlags;
in vec2 vExtra;
uniform sampler2D uTex;
uniform sampler2D uTexLinear;
uniform highp sampler2DArray uGlyphs;
uniform sampler2D uNormals;
uniform sampler2D uNormalBuf;
uniform sampler2D uScratch;
uniform vec2 uTargetSize;
uniform float uHasNormals;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormal;
float hash21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  int mode = int(vFlags.x + 0.5);
  int blend = mode & 3;
  int material = mode >> 2;
  int slot = int(vFlags.y + 0.5);
  vec4 n = vec4(0.0);
  vec3 rgb;
  float a;
  if (slot == 3) {
    // A procedural light: uv runs -1..1 from the centre, p0 is the height in radius units, p1 the falloff.
    float d = length(vUV);
    float atten = pow(clamp(1.0 - d, 0.0, 1.0), max(vExtra.y, 0.01));
    float lit = 1.0;
    if (uHasNormals > 0.5) {
      vec4 nb = texture(uNormalBuf, gl_FragCoord.xy / uTargetSize);
      if (nb.a > 0.01) {
        vec3 N = normalize(nb.rgb / nb.a * 2.0 - 1.0);
        N.y = -N.y;
        vec3 L = normalize(vec3(-vUV.x, -vUV.y, max(vExtra.x, 0.05)));
        lit = mix(0.15, 1.15, clamp(dot(N, L), 0.0, 1.0));
      }
    }
    rgb = vColor.rgb;
    a = atten * lit * vColor.a;
  } else if (slot == 4) {
    // The light scratch target, already premultiplied, added onto the light target.
    vec4 sc = texture(uScratch, gl_FragCoord.xy / uTargetSize);
    outColor = vec4(sc.rgb * vColor.a, 0.0);
    outNormal = vec4(0.0);
    return;
  } else {
    vec4 t;
    if (slot == 0) { t = texture(uTex, vUV); n = texture(uNormals, vUV); }
    else if (slot == 1) { t = texture(uTexLinear, vUV); n = texture(uNormals, vUV); }
    else t = vec4(1.0, 1.0, 1.0, texture(uGlyphs, vec3(vUV, vExtra.x)).a);
    rgb = t.rgb * vColor.rgb;
    a = t.a;
    if (material == 1) {
      rgb = mix(rgb, vec3(1.0), vExtra.x);
    } else if (material == 2) {
      float h = hash21(floor(vUV * 4096.0));
      if (h < vExtra.x) a = 0.0;
      else if (h < vExtra.x + vExtra.y) rgb = vColor.rgb;
    } else if (material == 3) {
      if (t.a < 0.5) {
        float near = texture(uTex, vUV + vec2(vExtra.x, 0.0)).a + texture(uTex, vUV - vec2(vExtra.x, 0.0)).a
                   + texture(uTex, vUV + vec2(0.0, vExtra.y)).a + texture(uTex, vUV - vec2(0.0, vExtra.y)).a;
        if (near > 0.5) { rgb = vColor.rgb; a = 1.0; } else a = 0.0;
      } else rgb = t.rgb;
    } else if (material == 4) {
      rgb = vColor.rgb;
    }
    a *= vColor.a;
  }
  if (blend == 2) {
    // Erase: multiply the target by 1 - alpha.
    outColor = vec4(0.0, 0.0, 0.0, a);
    outNormal = vec4(0.0);
    return;
  }
  // Premultiplied output; additive draws contribute colour but no coverage.
  outColor = vec4(rgb * a, a * (blend == 1 ? 0.0 : 1.0));
  float cov = blend == 1 ? 0.0 : step(0.5, a) * n.a;
  outNormal = vec4(n.rgb * cov, cov);
}`;

export const QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const BRIGHT_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uThreshold;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  float l = max(c.r, max(c.g, c.b));
  float knee = 0.15;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  outColor = vec4(c * w, 1.0);
}`;

export const BLUR_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 outColor;
void main() {
  float w0 = 0.227027, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.054054, w4 = 0.016216;
  vec3 c = texture(uTex, vUV).rgb * w0;
  c += texture(uTex, vUV + uDir * 1.0).rgb * w1 + texture(uTex, vUV - uDir * 1.0).rgb * w1;
  c += texture(uTex, vUV + uDir * 2.0).rgb * w2 + texture(uTex, vUV - uDir * 2.0).rgb * w2;
  c += texture(uTex, vUV + uDir * 3.0).rgb * w3 + texture(uTex, vUV - uDir * 3.0).rgb * w3;
  c += texture(uTex, vUV + uDir * 4.0).rgb * w4 + texture(uTex, vUV - uDir * 4.0).rgb * w4;
  outColor = vec4(c, 1.0);
}`;

/** Copies one texture into another; used to downsample the bloom chain. */
export const COPY_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, vUV).rgb, 1.0); }`;

export const COMPOSITE_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform sampler2D uLight;
uniform sampler2D uOverlay;
uniform sampler2D uLut;
uniform float uBloomStrength;
uniform float uLighting;
uniform float uUseLut;
uniform float uVignette;
uniform vec3 uTint;
uniform float uTintAmount;
uniform float uSaturation;
uniform float uContrast;
uniform float uBrightness;
uniform float uGrain;
uniform float uScanlines;
uniform float uScanPeriod;
uniform float uTime;
uniform vec2 uOffset;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = clamp(vUV - uOffset, 0.0, 1.0);
  vec3 c = texture(uScene, uv).rgb;
  if (uLighting > 0.5) c *= texture(uLight, uv).rgb;
  c += (texture(uBloomA, uv).rgb * 0.65 + texture(uBloomB, uv).rgb * 0.55) * uBloomStrength;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;
  c *= uBrightness;
  c = mix(c, c * uTint, uTintAmount);
  if (uUseLut > 0.5) {
    c = clamp(c, 0.0, 1.0);
    c = vec3(texture(uLut, vec2(c.r, 0.5)).r, texture(uLut, vec2(c.g, 0.5)).g, texture(uLut, vec2(c.b, 0.5)).b);
  }
  vec2 d = (vUV - 0.5) * vec2(1.15, 1.0);
  float v = smoothstep(0.35, 0.95, length(d) * 1.3);
  c *= 1.0 - v * uVignette;
  if (uGrain > 0.0) c += (hash(gl_FragCoord.xy + fract(uTime) * 1000.0) - 0.5) * uGrain;
  if (uScanlines > 0.0) c *= 1.0 - uScanlines * 0.5 * (1.0 + sin(gl_FragCoord.y / uScanPeriod * 6.2831853));
  vec4 o = texture(uOverlay, vUV);
  c = o.rgb + c * (1.0 - o.a);
  outColor = vec4(c, 1.0);
}`;
