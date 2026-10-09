import { Vec3 } from "./math.ts";
let nextGeometry = 1;
/** Indexed triangle geometry. Reusing it shares GPU buffers; WebGL2 also batches matching meshes as instances. */
export class Geometry3D {
  readonly id = nextGeometry++;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly uvs: Float32Array;
  version = 1;
  readonly center = new Vec3();
  readonly radius: number;
  disposed = false;
  constructor(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    indices: ArrayLike<number>,
    uvs?: ArrayLike<number>,
  ) {
    if (
      !positions.length ||
      positions.length % 3 ||
      normals.length !== positions.length ||
      !indices.length ||
      indices.length % 3
    )
      throw new RangeError(
        "Geometry3D requires XYZ positions/normals and triangle indices",
      );
    for (let i = 0; i < positions.length; i++)
      if (!Number.isFinite(positions[i]) || !Number.isFinite(normals[i]))
        throw new RangeError("Geometry3D attributes must be finite");
    for (let i = 0; i < indices.length; i++)
      if (
        !Number.isInteger(indices[i]) ||
        indices[i] < 0 ||
        indices[i] >= positions.length / 3
      )
        throw new RangeError("Geometry3D index outside vertex buffer");
    if (uvs && (uvs.length !== positions.length / 3 * 2 || Array.from(uvs).some(v => !Number.isFinite(v)))) throw new RangeError("Invalid texture coordinates");
    this.uvs = uvs ? new Float32Array(uvs) : new Float32Array(positions.length / 3 * 2);
    this.positions = new Float32Array(positions);
    this.normals = new Float32Array(normals);
    this.indices = new Uint32Array(indices);
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      maxY = Math.max(maxY, positions[i + 1]);
      minZ = Math.min(minZ, positions[i + 2]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
    this.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    let radius = 0;
    for (let i = 0; i < positions.length; i += 3)
      radius = Math.max(
        radius,
        Math.hypot(
          positions[i] - this.center.x,
          positions[i + 1] - this.center.y,
          positions[i + 2] - this.center.z,
        ),
      );
    this.radius = radius;
  }
  /** Releases cached GPU buffers on the next frame. Do not dispose a still-shared geometry. */
  /** Call after editing positions/normals/UVs. Animated meshes must disable static frustum bounds. */
  touch(): void { if (this.disposed) throw new Error("Disposed geometry"); this.version++; }
  dispose(): void {
    this.disposed = true;
  }
  /** A chamfered cuboid with flat face/edge/corner normals and per-face UVs. */
  static beveledBox(width=1,height=1,depth=1,bevel=0.06):Geometry3D {
    dimensions(width,height,depth,bevel);
    const half=[width/2,height/2,depth/2];
    if(bevel>=Math.min(...half))throw new RangeError("Bevel must be smaller than every half dimension");
    const inner=half.map(h=>h-bevel),positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[];
    const face=(vertices:number[][])=>{
      const a=new Vec3(...vertices[0] as [number,number,number]),b=new Vec3(...vertices[1] as [number,number,number]),c=new Vec3(...vertices[2] as [number,number,number]);
      const normal=b.sub(a).cross(c.sub(a)).normalize();
      const center=vertices.reduce((v,p)=>v.add(new Vec3(...p as [number,number,number])),new Vec3());
      if(normal.dot(center)<0){vertices.reverse();normal.multiplyScalar(-1);}
      const base=positions.length/3;
      vertices.forEach((p,i)=>{positions.push(...p);normals.push(normal.x,normal.y,normal.z);uvs.push(...[[0,0],[1,0],[1,1],[0,1]][i]);});
      for(let i=1;i<vertices.length-1;i++)indices.push(base,base+i,base+i+1);
    };
    for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){
      const u=(axis+1)%3,v=(axis+2)%3;
      face([[-1,-1],[1,-1],[1,1],[-1,1]].map(([su,sv])=>{const p=[0,0,0];p[axis]=half[axis]*sign;p[u]=inner[u]*su;p[v]=inner[v]*sv;return p;}));
    }
    for(let a=0;a<3;a++)for(let b=a+1;b<3;b++)for(const sa of [-1,1])for(const sb of [-1,1]){
      const c=3-a-b;
      face([[0,-1],[1,-1],[1,1],[0,1]].map(([side,sc])=>{const p=[0,0,0];p[a]=(side?inner[a]:half[a])*sa;p[b]=(side?half[b]:inner[b])*sb;p[c]=inner[c]*sc;return p;}));
    }
    for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])face([0,1,2].map(axis=>[sx,sy,sz].map((s,i)=>s*(i===axis?half[i]:inner[i]))));
    return new Geometry3D(positions,normals,indices,uvs);
  }
  static box(width = 1, height = 1, depth = 1): Geometry3D {
    dimensions(width, height, depth);
    const p: number[] = [],
      n: number[] = [],
      idx: number[] = [];
    const face = (
      center: number[],
      u: number[],
      v: number[],
      normal: number[],
    ) => {
      const first = p.length / 3;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        for (let k = 0; k < 3; k++) p.push(center[k] + a * u[k] + b * v[k]);
        n.push(...normal);
      }
      idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
    };
    const x = width / 2,
      y = height / 2,
      z = depth / 2;
    face([x, 0, 0], [0, 0, -z], [0, y, 0], [1, 0, 0]);
    face([-x, 0, 0], [0, 0, z], [0, y, 0], [-1, 0, 0]);
    face([0, y, 0], [x, 0, 0], [0, 0, -z], [0, 1, 0]);
    face([0, -y, 0], [x, 0, 0], [0, 0, z], [0, -1, 0]);
    face([0, 0, z], [x, 0, 0], [0, y, 0], [0, 0, 1]);
    face([0, 0, -z], [-x, 0, 0], [0, y, 0], [0, 0, -1]);
    return new Geometry3D(p, n, idx, Array.from({ length: 6 }, () => [0, 1, 1, 1, 1, 0, 0, 0]).flat());
  }
  /** Plane lies on XZ with its normal pointing up. */
  static plane(width = 1, depth = 1): Geometry3D {
    dimensions(width, depth);
    const x = width / 2,
      z = depth / 2;
    return new Geometry3D(
      [-x, 0, z, x, 0, z, x, 0, -z, -x, 0, -z],
      [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
      [0, 1, 2, 0, 2, 3],
      [0, 1, 1, 1, 1, 0, 0, 0],
    );
  }
  /** Flat XZ annulus with +Y normals. Use innerRadius = 0 for a solid disc. */
  static ring(outerRadius = 1, innerRadius = outerRadius * 0.85, segments = 32): Geometry3D {
    dimensions(outerRadius);
    if (
      !Number.isFinite(innerRadius) ||
      innerRadius < 0 ||
      innerRadius >= outerRadius
    )
      throw new RangeError(
        "Ring innerRadius must be finite, nonnegative, and less than outerRadius",
      );
    segments = tessellation(segments, 3);
    const positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [];
    if (innerRadius === 0) {
      positions.push(0, 0, 0);
      normals.push(0, 1, 0);
      for (let i = 0; i < segments; i++) {
        const angle = (i * Math.PI * 2) / segments;
        positions.push(
          Math.cos(angle) * outerRadius,
          0,
          Math.sin(angle) * outerRadius,
        );
        normals.push(0, 1, 0);
      }
      for (let i = 0; i < segments; i++)
        indices.push(0, ((i + 1) % segments) + 1, i + 1);
    } else {
      for (let i = 0; i < segments; i++) {
        const angle = (i * Math.PI * 2) / segments,
          cos = Math.cos(angle),
          sin = Math.sin(angle);
        positions.push(
          cos * outerRadius,
          0,
          sin * outerRadius,
          cos * innerRadius,
          0,
          sin * innerRadius,
        );
        normals.push(0, 1, 0, 0, 1, 0);
      }
      for (let i = 0; i < segments; i++) {
        const a = i * 2,
          b = ((i + 1) % segments) * 2;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    return new Geometry3D(positions, normals, indices, Array.from({ length: positions.length / 3 }, (_, i) => [positions[i * 3] / (2 * outerRadius) + 0.5, positions[i * 3 + 2] / (2 * outerRadius) + 0.5]).flat());
  }
  static sphere(radius = 0.5, segments = 16, rings = 10): Geometry3D {
    dimensions(radius);
    segments = tessellation(segments, 3);
    rings = tessellation(rings, 2);
    const p: number[] = [],
      n: number[] = [],
      idx: number[] = [];
    for (let j = 0; j <= rings; j++)
      for (let i = 0; i <= segments; i++) {
        const theta = (j * Math.PI) / rings,
          phi = (i * Math.PI * 2) / segments;
        const x = Math.sin(theta) * Math.sin(phi),
          y = Math.cos(theta),
          z = Math.sin(theta) * Math.cos(phi);
        p.push(x * radius, y * radius, z * radius);
        n.push(x, y, z);
      }
    for (let j = 0; j < rings; j++)
      for (let i = 0; i < segments; i++) {
        const a = j * (segments + 1) + i,
          b = a + 1,
          c = a + segments + 1,
          d = c + 1;
        if (j > 0) idx.push(a, c, b);
        if (j < rings - 1) idx.push(b, c, d);
      }
    return new Geometry3D(p, n, idx, Array.from({ length: p.length / 3 }, (_, i) => [(i % (segments + 1)) / segments, Math.floor(i / (segments + 1)) / rings]).flat());
  }
  /** Y-axis cylinder, or tapered cone when radiusTop differs. */
  static cylinder(
    radius = 0.5,
    height = 1,
    segments = 16,
    radiusTop = radius,
  ): Geometry3D {
    dimensions(radius, height);
    if (!Number.isFinite(radiusTop) || radiusTop < 0)
      throw new RangeError("radiusTop must be nonnegative");
    segments = tessellation(segments, 3);
    const p: number[] = [],
      n: number[] = [],
      idx: number[] = [];
    const slope = (radius - radiusTop) / height,
      inv = 1 / Math.hypot(1, slope);
    for (let i = 0; i <= segments; i++) {
      const a = (i * Math.PI * 2) / segments,
        c = Math.cos(a),
        s = Math.sin(a);
      p.push(
        c * radiusTop,
        height / 2,
        s * radiusTop,
        c * radius,
        -height / 2,
        s * radius,
      );
      n.push(c * inv, slope * inv, s * inv, c * inv, slope * inv, s * inv);
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
    }
    for (const top of [false, true]) {
      const r = top ? radiusTop : radius;
      if (r === 0) continue;
      const c = p.length / 3,
        y = top ? height / 2 : -height / 2,
        ny = top ? 1 : -1;
      p.push(0, y, 0);
      n.push(0, ny, 0);
      for (let i = 0; i <= segments; i++) {
        const a = (i * Math.PI * 2) / segments;
        p.push(Math.cos(a) * r, y, Math.sin(a) * r);
        n.push(0, ny, 0);
      }
      for (let i = 0; i < segments; i++) {
        if (top) idx.push(c, c + i + 2, c + i + 1);
        else idx.push(c, c + i + 1, c + i + 2);
      }
    }
    return new Geometry3D(p, n, idx, Array.from({ length: p.length / 3 }, (_, i) => i < (segments + 1) * 2 ? [Math.floor(i / 2) / segments, i % 2] : [p[i * 3] / (2 * radius) + 0.5, p[i * 3 + 2] / (2 * radius) + 0.5]).flat());
  }
  static cone(radius = 0.5, height = 1, segments = 16): Geometry3D {
    return Geometry3D.cylinder(radius, height, segments, 0);
  }
  static torus(radius = 1, tube = 0.2, segments = 24, sides = 8): Geometry3D {
    dimensions(radius, tube);
    segments = tessellation(segments, 3);
    sides = tessellation(sides, 3);
    const p: number[] = [],
      n: number[] = [],
      idx: number[] = [];
    for (let j = 0; j <= segments; j++)
      for (let i = 0; i <= sides; i++) {
        const u = (j * Math.PI * 2) / segments,
          v = (i * Math.PI * 2) / sides,
          c = Math.cos(u),
          s = Math.sin(u),
          cv = Math.cos(v),
          sv = Math.sin(v);
        p.push((radius + tube * cv) * c, tube * sv, (radius + tube * cv) * s);
        n.push(cv * c, sv, cv * s);
      }
    for (let j = 0; j < segments; j++)
      for (let i = 0; i < sides; i++) {
        const a = j * (sides + 1) + i,
          b = a + sides + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    return new Geometry3D(p, n, idx, Array.from({ length: p.length / 3 }, (_, i) => [Math.floor(i / (sides + 1)) / segments, (i % (sides + 1)) / sides]).flat());
  }
}
function dimensions(...values: number[]): void {
  if (values.some((v) => !Number.isFinite(v) || v <= 0))
    throw new RangeError("Primitive dimensions must be positive and finite");
}
function tessellation(v: number, min: number): number {
  if (!Number.isInteger(v) || v < min || v > 512)
    throw new RangeError(`Tessellation must be an integer from ${min} to 512`);
  return v;
}
