import type { Node } from "../scene/node.ts";
import { Camera3D } from "../three/camera.ts";
import { Vec3, mat4Identity, mat4Invert, mat4Point } from "../three/math.ts";
import { Node3D } from "../three/node.ts";
import { Mesh3D } from "../three/scene.ts";

export interface MeshPick {
  id: string;
  mesh: Mesh3D;
  /** Distance from the camera ray origin in world units. */
  distance: number;
}

/** Pick the nearest visible triangle, including back faces, in scene-document nodes. */
export function pickSceneMesh(nodes: ReadonlyMap<string, Node>, camera: Camera3D, x: number, y: number, width: number, height: number): MeshPick | null {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const ray = camera.screenRay(x, y, width, height);
  let best: MeshPick | null = null;
  for (const [id, node] of nodes) {
    if (!(node instanceof Mesh3D) || node.geometry.disposed || node.material.opacity <= 0) continue;
    let visible = true;
    for (let parent: Node | null = node; parent; parent = parent.parent) if (!parent.visible) { visible = false; break; }
    if (!visible) continue;
    const inverse = mat4Identity();
    if (!mat4Invert(inverse, node.updateWorldMatrix())) continue;
    const origin = mat4Point(inverse, ray.origin);
    const next = mat4Point(inverse, ray.at(1));
    const dx = next.x - origin.x, dy = next.y - origin.y, dz = next.z - origin.z;
    const vertices = node.geometry.positions, indices = node.geometry.indices;
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const e1x = vertices[b] - vertices[a], e1y = vertices[b + 1] - vertices[a + 1], e1z = vertices[b + 2] - vertices[a + 2];
      const e2x = vertices[c] - vertices[a], e2y = vertices[c + 1] - vertices[a + 1], e2z = vertices[c + 2] - vertices[a + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const determinant = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(determinant) < 1e-9) continue;
      const inv = 1 / determinant;
      const tx = origin.x - vertices[a], ty = origin.y - vertices[a + 1], tz = origin.z - vertices[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (distance >= 0 && (!best || distance < best.distance)) best = { id, mesh: node, distance };
    }
  }
  return best;
}

/** Convert a world-space drag position back into the node's parent coordinate system. */
export function worldPointInParent(node: Node3D, point: Readonly<Vec3>, out = new Vec3()): Vec3 {
  let parent: Node | null = node.parent;
  while (parent && !(parent instanceof Node3D)) parent = parent.parent;
  if (!(parent instanceof Node3D)) return out.copy(point);
  const inverse = mat4Identity();
  if (!mat4Invert(inverse, parent.updateWorldMatrix())) throw new Error("Cannot move a node under a singular parent transform");
  return mat4Point(inverse, point, out);
}
