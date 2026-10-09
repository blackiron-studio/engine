struct Uniforms {
  vp: mat4x4<f32>, model: mat4x4<f32>, normal: mat4x4<f32>, light: mat4x4<f32>,
  color: vec4<f32>, material: vec4<f32>, emission: vec4<f32>, eye: vec4<f32>, ambient: vec4<f32>, ground: vec4<f32>, sun: vec4<f32>, sunColor: vec4<f32>, fog: vec4<f32>, maps: vec4<f32>, flags: vec4<f32>,
  points: array<vec4<f32>,8>, pointColors: array<vec4<f32>,8>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var baseMap: texture_2d<f32>;
@group(0) @binding(2) var baseSampler: sampler;
@group(0) @binding(3) var normalMap: texture_2d<f32>;
@group(0) @binding(4) var normalSampler: sampler;
@group(0) @binding(5) var mrMap: texture_2d<f32>;
@group(0) @binding(6) var mrSampler: sampler;
@group(0) @binding(7) var emissionMap: texture_2d<f32>;
@group(0) @binding(8) var emissionSampler: sampler;
@group(0) @binding(9) var shadowMap: texture_depth_2d;
struct Vertex { @location(0) position:vec3<f32>, @location(1) normal:vec3<f32>, @location(2) uv:vec2<f32> };
struct Instance {
  @location(3) model0:vec4<f32>, @location(4) model1:vec4<f32>, @location(5) model2:vec4<f32>, @location(6) model3:vec4<f32>,
  @location(7) normal0:vec4<f32>, @location(8) normal1:vec4<f32>, @location(9) normal2:vec4<f32>, @location(10) normal3:vec4<f32>,
  @location(11) color:vec4<f32>, @location(12) mirror:f32,
};
struct Out { @builtin(position) clip:vec4<f32>, @location(0) position:vec3<f32>, @location(1) normal:vec3<f32>, @location(2) uv:vec2<f32>, @location(3) shadow:vec4<f32>, @location(4) color:vec4<f32>, @location(5) @interpolate(flat) mirror:f32 };
fn clipDepth(p:vec4<f32>)->vec4<f32>{return vec4(p.xy,(p.z+p.w)*0.5,p.w);}
@vertex fn vs(v:Vertex)->Out {
  var o:Out;let p=u.model*vec4(v.position,1.0);o.clip=clipDepth(u.vp*p);o.position=p.xyz;o.normal=(u.normal*vec4(v.normal,0.0)).xyz;o.uv=v.uv;o.shadow=u.light*p;o.color=u.color;o.mirror=u.flags.w;return o;
}
@vertex fn depth_vs(v:Vertex)->Out {
  var o:Out;let p=u.model*vec4(v.position,1.0);o.clip=clipDepth(u.light*p);o.position=p.xyz;o.normal=v.normal;o.uv=v.uv;o.shadow=vec4(0.0);o.color=u.color;o.mirror=u.flags.w;return o;
}
@vertex fn vs_instanced(v:Vertex,i:Instance)->Out {
  let model=mat4x4<f32>(i.model0,i.model1,i.model2,i.model3);
  let normal=mat4x4<f32>(i.normal0,i.normal1,i.normal2,i.normal3);
  var o:Out;let p=model*vec4(v.position,1.0);o.clip=clipDepth(u.vp*p);o.position=p.xyz;o.normal=(normal*vec4(v.normal,0.0)).xyz;o.uv=v.uv;o.shadow=u.light*p;o.color=i.color;o.mirror=i.mirror;return o;
}
@vertex fn depth_vs_instanced(v:Vertex,i:Instance)->Out {
  let model=mat4x4<f32>(i.model0,i.model1,i.model2,i.model3);
  var o:Out;let p=model*vec4(v.position,1.0);o.clip=clipDepth(u.light*p);o.position=p.xyz;o.normal=v.normal;o.uv=v.uv;o.shadow=vec4(0.0);o.color=i.color;o.mirror=i.mirror;return o;
}
@fragment fn depth_fs(v:Out) {
  let texel=textureSample(baseMap,baseSampler,v.uv);
  if(u.emission.w>=0.0 && select(1.0,texel.a,u.maps.x>0.5)*v.color.a<u.emission.w){discard;}
}
fn linear(c:vec3<f32>)->vec3<f32>{return pow(max(c,vec3(0.0)),vec3(2.2));}
fn aces(x:vec3<f32>)->vec3<f32>{return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),vec3(0.0),vec3(1.0));}
fn shadow(v:Out,n:vec3<f32>)->f32 {
  if(u.sunColor.w<0.5){return 1.0;}
  let p=v.shadow.xyz/v.shadow.w*0.5+0.5;
  if(p.z<=0.0||p.z>=1.0||any(p.xy<vec2(0.0))||any(p.xy>vec2(1.0))){return 1.0;}
  let size=textureDimensions(shadowMap);let uv=vec2(p.x,1.0-p.y);let at=vec2<i32>(uv*vec2<f32>(size));
  let bias=max(u.sun.w*(1.0-dot(n,u.sun.xyz)),u.sun.w*0.25);var lit=0.0;
  for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let xy=clamp(at+vec2(x,y),vec2(0),vec2<i32>(size)-vec2(1));let d=textureLoad(shadowMap,xy,0);lit+=select(0.0,1.0,p.z-bias<=d);}}
  return lit/9.0;
}
fn brdf(n:vec3<f32>,v:vec3<f32>,l:vec3<f32>,radiance:vec3<f32>,base:vec3<f32>,rough:f32,metal:f32)->vec3<f32>{
  let nl=max(dot(n,l),0.0);let nv=max(dot(n,v),0.001);if(nl<=0.0){return vec3(0.0);}
  let h=normalize(v+l);let nh=max(dot(n,h),0.0);let vh=max(dot(v,h),0.0);
  let a=max(0.045,rough*rough);let a2=a*a;let denom=nh*nh*(a2-1.0)+1.0;let d=a2/(3.14159265*denom*denom);
  let k=(rough+1.0)*(rough+1.0)/8.0;let g=(nv/(nv*(1.0-k)+k))*(nl/(nl*(1.0-k)+k));
  let f0=mix(vec3(0.04),base,metal);let f=f0+(vec3(1.0)-f0)*pow(1.0-vh,5.0);
  let spec=d*g*f/max(4.0*nv*nl,0.001);let diffuse=(vec3(1.0)-f)*(1.0-metal)*base/3.14159265;return(diffuse+spec)*radiance*nl;
}
@fragment fn fs(v:Out,@builtin(front_facing) front:bool)->@location(0) vec4<f32>{
  let texel=textureSample(baseMap,baseSampler,v.uv);let mrTex=textureSample(mrMap,mrSampler,v.uv);let normalTex=textureSample(normalMap,normalSampler,v.uv);let emissionTex=textureSample(emissionMap,emissionSampler,v.uv);
  let dp1=dpdx(v.position);let dp2=dpdy(v.position);let duv1=dpdx(v.uv);let duv2=dpdy(v.uv);
  let facing=front!=(v.mirror>0.5);if(!facing && u.flags.z<0.5){discard;}
  let alpha=v.color.a*select(1.0,texel.a,u.maps.x>0.5);if(u.emission.w>=0.0 && alpha<u.emission.w){discard;}
  let palette=v.color.rgb*select(vec3(1.0),texel.rgb,u.maps.x>0.5);let base=linear(palette);
  let rough=clamp(u.material.x*select(1.0,mrTex.g,u.maps.z>0.5),0.04,1.0);let metal=clamp(u.material.y*select(1.0,mrTex.b,u.maps.z>0.5),0.0,1.0);
  let emission=u.emission.rgb*select(vec3(1.0),linear(emissionTex.rgb),u.maps.w>0.5);
  var n=normalize(v.normal)*select(-1.0,1.0,front);let det=duv1.x*duv2.y-duv1.y*duv2.x;
  let t=dp1*duv2.y-dp2*duv1.y;let b=-dp1*duv2.x+dp2*duv1.x;
  if(u.maps.y>0.5 && abs(det)>0.000001 && dot(t,t)>0.000001 && dot(b,b)>0.000001){n=normalize(mat3x3(normalize(t*sign(det)),normalize(b*sign(det)),n)*(normalTex.xyz*2.0-1.0));}
  var color=base;
  if(u.material.z<1.5){
    let view=normalize(u.eye.xyz-v.position);let sun=u.sunColor.rgb*max(dot(n,u.sun.xyz),0.0)*shadow(v,n);
    var lighting=vec3(u.ambient.w)+u.ground.w*sun;
    color=base*mix(linear(u.ground.rgb),linear(u.ambient.rgb),n.y*0.5+0.5)*(1.0-0.65*metal)+brdf(n,view,u.sun.xyz,u.sunColor.rgb,base,rough,metal)*shadow(v,n);
    for(var i=0u;i<8u;i++){if(f32(i)>=u.flags.x){break;}let delta=u.points[i].xyz-v.position;let dist=length(delta);let range=u.points[i].w;let falloff=pow(clamp(1.0-pow(dist/range,4.0),0.0,1.0),2.0)/(1.0+dist*dist);let direction=delta/max(dist,0.0001);lighting+=u.ground.w*u.pointColors[i].rgb*falloff*max(dot(n,direction),0.0);color+=brdf(n,view,direction,u.pointColors[i].rgb*falloff,base,rough,metal);}
    if(u.material.z>0.5){color=linear(palette*lighting);}
  }
  color+=emission;if(u.material.w>0.5){color=aces(color*max(0.01,u.eye.w));}
  let fog=clamp(1.0-exp(-max(0.0,u.fog.w)*length(u.eye.xyz-v.position)),0.0,1.0);color=mix(color,linear(u.fog.rgb),fog);color=pow(max(color,vec3(0.0)),vec3(1.0/2.2));let opacity=select(1.0,alpha,u.flags.y>0.5);return vec4(color*opacity,opacity);
}
