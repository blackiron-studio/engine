export const MESH3D_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=7) in vec2 aUV;
out vec2 vUV;
layout(location=2) in mat4 aModel;
layout(location=6) in vec3 aTint;
uniform highp int uShading;
uniform mat4 uViewProjection;
uniform mat4 uLightMatrix;
out vec3 vPosition;
out vec3 vNormal;
out vec4 vShadow;
flat out vec3 vTint;
void main(){
  vec4 world=aModel*vec4(aPosition,1.0);
  vPosition=world.xyz;
  vUV=aUV;
  vTint=aTint;
  if(uShading==2){
    vNormal=vec3(0.0);
    vShadow=vec4(0.0);
  }else{
    vNormal=transpose(inverse(mat3(aModel)))*aNormal;
    vShadow=uLightMatrix*world;
  }
  gl_Position=uViewProjection*world;
}
`;
export const DEPTH3D_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=7) in vec2 aUV;
out vec2 vUV;
layout(location=2) in mat4 aModel;
uniform mat4 uViewProjection;
void main(){vUV=aUV;gl_Position=uViewProjection*aModel*vec4(aPosition,1.0);}
`;
export const DEPTH3D_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uAlphaCutoff;
uniform float uOpacity;
void main(){if(uAlphaCutoff>=0.0 && (uHasMap>0.5 ? texture(uMap,vUV).a : 1.0)*uOpacity<uAlphaCutoff)discard;}
`;
export const MESH3D_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
in vec3 vPosition;
in vec3 vNormal;
in vec4 vShadow;
flat in vec3 vTint;
layout(location=0) out vec4 outColor;
uniform vec3 uColor;
uniform float uRoughness;
uniform float uMetallic;
uniform vec3 uEmissive;
uniform float uOpacity;
uniform highp int uShading;
uniform float uToneMapped;
uniform float uLambertAmbient;
uniform float uLambertDiffuse;
uniform vec3 uEye;
uniform vec3 uAmbient;
uniform vec3 uGround;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uExposure;
uniform int uPointCount;
uniform vec4 uPointPositionRange[8];
uniform vec3 uPointColor[8];
uniform sampler2D uShadow;
uniform float uShadowEnabled;
uniform float uShadowTexel;
uniform float uShadowBias;
uniform float uReceiveShadow;
uniform sampler2D uMap;
uniform sampler2D uNormalMap;
uniform sampler2D uMetallicRoughnessMap;
uniform sampler2D uEmissiveMap;
uniform vec4 uMaps;
uniform float uAlphaCutoff;
uniform float uBlendAlpha;
float surfaceAlpha;
float roughness;
float metallic;
vec3 emission;
const float PI=3.14159265359;
vec3 linearColor(vec3 c){return pow(c,vec3(2.2));}
vec3 brdf(vec3 N,vec3 V,vec3 L,vec3 radiance,vec3 base){
  float nl=max(dot(N,L),0.0),nv=max(dot(N,V),0.001);
  if(nl<=0.0)return vec3(0.0);
  vec3 H=normalize(V+L);
  float nh=max(dot(N,H),0.0),vh=max(dot(V,H),0.0);
  float a=max(0.045,roughness*roughness),a2=a*a;
  float denom=nh*nh*(a2-1.0)+1.0;
  float D=a2/(PI*denom*denom);
  float k=(roughness+1.0)*(roughness+1.0)/8.0;
  float G=(nv/(nv*(1.0-k)+k))*(nl/(nl*(1.0-k)+k));
  vec3 F0=mix(vec3(0.04),base,metallic);
  vec3 F=F0+(1.0-F0)*pow(1.0-vh,5.0);
  vec3 spec=D*G*F/max(4.0*nv*nl,0.001);
  vec3 diffuse=(1.0-F)*(1.0-metallic)*base/PI;
  return (diffuse+spec)*radiance*nl;
}
float shadow(vec3 N){
  if(uShadowEnabled<0.5||uReceiveShadow<0.5)return 1.0;
  vec3 p=vShadow.xyz/vShadow.w*0.5+0.5;
  if(p.z<=0.0||p.z>=1.0||any(lessThan(p.xy,vec2(0.0)))||any(greaterThan(p.xy,vec2(1.0))))return 1.0;
  float bias=max(uShadowBias*(1.0-dot(N,uSunDirection)),uShadowBias*0.25);
  float lit=0.0;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){float d=texture(uShadow,p.xy+vec2(float(x),float(y))*uShadowTexel).r;lit+=p.z-bias<=d?1.0:0.0;}
  return lit/9.0;
}
vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);}
// All modes finish in linear color so fog/post behavior stays consistent. Materials
// that bypass tone mapping also bypass exposure, preserving authored palette values.
void finishColor(vec3 color){
  if(uToneMapped>0.5)color=aces(color*uExposure);
  float fog=1.0-exp(-uFogDensity*length(uEye-vPosition));
  color=mix(color,linearColor(uFogColor),clamp(fog,0.0,1.0));
  color=pow(max(color,vec3(0.0)),vec3(1.0/2.2));
  outColor=vec4(color*surfaceAlpha,surfaceAlpha);
}
void main(){
  vec4 texel=uMaps.x>0.5?texture(uMap,vUV):vec4(1.0);
  float alpha=texel.a*uOpacity;
  if(uAlphaCutoff>=0.0 && alpha<uAlphaCutoff)discard;
  surfaceAlpha=uBlendAlpha>0.5?alpha:1.0;
  vec4 mr=uMaps.z>0.5?texture(uMetallicRoughnessMap,vUV):vec4(1.0);
  roughness=clamp(uRoughness*mr.g,0.04,1.0);
  metallic=clamp(uMetallic*mr.b,0.0,1.0);
  emission=uEmissive*(uMaps.w>0.5?linearColor(texture(uEmissiveMap,vUV).rgb):vec3(1.0));
  vec3 palette=uColor*vTint*texel.rgb;
  vec3 base=linearColor(palette);
  // A uniform branch avoids normal, BRDF, point-light, and shadow work for unlit
  // markings, particles, and effects; this is not a final mix after all lighting.
  if(uShading==2){finishColor(base+emission);return;}
  vec3 N=normalize(vNormal);
  if(!gl_FrontFacing)N=-N;
  if(uMaps.y>0.5){
    vec3 dp1=dFdx(vPosition),dp2=dFdy(vPosition);
    vec2 duv1=dFdx(vUV),duv2=dFdy(vUV);
    vec3 T=dp1*duv2.y-dp2*duv1.y,B=-dp1*duv2.x+dp2*duv1.x;
    float det=duv1.x*duv2.y-duv1.y*duv2.x;
    if(abs(det)>0.000001 && dot(T,T)>0.000001 && dot(B,B)>0.000001){
      T=normalize(T*sign(det)); B=normalize(B*sign(det));
      N=normalize(mat3(T,B,N)*(texture(uNormalMap,vUV).xyz*2.0-1.0));
    }
  }
  if(uShading==1){
    vec3 lighting=vec3(uLambertAmbient);
    lighting+=uLambertDiffuse*uSunColor*max(dot(N,uSunDirection),0.0)*shadow(N);
    for(int i=0;i<8;i++){
      if(i>=uPointCount)break;
      vec3 delta=uPointPositionRange[i].xyz-vPosition;
      float dist=length(delta),range=uPointPositionRange[i].w;
      float falloff=pow(clamp(1.0-pow(dist/range,4.0),0.0,1.0),2.0)/(1.0+dist*dist);
      lighting+=uLambertDiffuse*uPointColor[i]*falloff*max(dot(N,delta/max(dist,0.0001)),0.0);
    }
    finishColor(linearColor(palette*lighting)+emission);
    return;
  }
  vec3 V=normalize(uEye-vPosition);
  vec3 hemi=mix(linearColor(uGround),linearColor(uAmbient),N.y*0.5+0.5);
  vec3 color=base*hemi*(1.0-0.65*metallic);
  color+=brdf(N,V,uSunDirection,uSunColor,base)*shadow(N);
  for(int i=0;i<8;i++){
    if(i>=uPointCount)break;
    vec3 delta=uPointPositionRange[i].xyz-vPosition;
    float dist=length(delta),range=uPointPositionRange[i].w;
    float falloff=pow(clamp(1.0-pow(dist/range,4.0),0.0,1.0),2.0)/(1.0+dist*dist);
    color+=brdf(N,V,delta/max(dist,0.0001),uPointColor[i]*falloff,base);
  }
  finishColor(color+emission);
}
`;
