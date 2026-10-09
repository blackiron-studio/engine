import {
  SceneEditor,
  createSceneRegistry,
  type SceneNodeData,
  type SceneInstance,
} from "../src/content/scene.ts";
import { pickSceneMesh, worldPointInParent } from "../src/content/editor-geometry.ts";
import { Mesh3D } from "../src/three/scene.ts";
import { Vec3, mat4Point } from "../src/three/math.ts";
import { Scene3D } from "../src/three/scene.ts";
import { Node3D } from "../src/three/node.ts";
import { WebGL2Renderer } from "../src/render/webgl2.ts";
import { bakeAtlas } from "../src/art/atlas.ts";
import { defaultPost } from "../src/render/types.ts";
import { DrawContext } from "../src/scene/draw.ts";

document.body.innerHTML = `<style>
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#11242c;color:#e8eadf;font:14px system-ui}button,input,textarea{font:inherit;background:#213943;color:inherit;border:1px solid #577078;border-radius:5px;padding:8px}button{cursor:pointer}header{padding:16px;display:flex;gap:10px;align-items:center}main{display:grid;grid-template-columns:230px minmax(0,1fr) 310px;gap:16px;padding:0 16px}aside{display:flex;flex-direction:column;gap:8px}#viewport{position:relative;min-width:0}canvas{display:block;width:100%;aspect-ratio:4/3;background:#14252c;border-radius:8px;touch-action:none}#gizmo{position:absolute;width:24px;height:24px;border:2px solid #ffdc80;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #17232b,0 0 12px #ffcc55;pointer-events:none}#gizmo:before,#gizmo:after{content:"";position:absolute;background:#ffdc80}#gizmo:before{width:1px;height:34px;left:10px;top:-7px}#gizmo:after{height:1px;width:34px;top:10px;left:-7px}textarea{width:100%;min-height:260px;font:12px monospace}pre{white-space:pre-wrap;font:12px monospace}h1{font-size:19px;margin:0 16px 0 0}label{display:grid;gap:6px}#status{padding:12px 16px;color:#efd4a0}#tree button{text-align:left}#tree button[aria-current=true]{border-color:#ffdc80;background:#38505a}#transform{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}#transform input{min-width:0;width:100%}small{color:#acc4c9}</style>
<header><h1>Kiln scene editor</h1><input id="file" aria-label="Scene file" value="main"><button id="load">Load</button><button id="save">Save to project</button><button id="undo">Undo</button><button id="redo">Redo</button><button id="add">Add box</button><button id="delete">Delete selected</button></header>
<div id="status" role="status">Loading…</div><main><aside id="tree"></aside><section><div id="viewport"><canvas></canvas><div id="gizmo" hidden></div></div><small>Click a mesh to select · Shift-drag to place it on a horizontal plane · drag to orbit · wheel to zoom. Save to keep edits.</small><pre id="diagnostics"></pre></section><aside><label>Name<input id="name"></label><div id="transform"><label>PX<input id="tx" type="number" step="0.1"></label><label>PY<input id="ty" type="number" step="0.1"></label><label>PZ<input id="tz" type="number" step="0.1"></label><label>RX°<input id="rx" type="number" step="1"></label><label>RY°<input id="ry" type="number" step="1"></label><label>RZ°<input id="rz" type="number" step="1"></label><label>SX<input id="sx" type="number" step="0.1"></label><label>SY<input id="sy" type="number" step="0.1"></label><label>SZ<input id="sz" type="number" step="0.1"></label></div><button id="apply-transform">Apply transform</button><label>Properties (JSON)<textarea id="props" spellcheck="false"></textarea></label><button id="apply">Apply properties</button><small>Prefab overrides remain in the scene document. Custom gameplay types need registered codecs.</small><details><summary>Full scene document</summary><textarea id="source" spellcheck="false"></textarea><button id="replace">Apply document</button></details></aside></main>`;
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = (message: string) => (element("status").textContent = message);
const canvas = document.querySelector("canvas")!,
  renderer = new WebGL2Renderer(canvas, 800, 600, { scale: 1 }),
  atlas = bakeAtlas();
renderer.resize(800, 600, 1);
renderer.uploadAtlas(atlas);
renderer.profiling = true;
const context = new DrawContext(renderer, atlas),
  scene = new Scene3D(800, 600),
  post = defaultPost(),
  registry = createSceneRegistry();
scene.environment.fogDensity = 0;
let yaw = 0.65,
  distance = 14;
const focus = new Vec3();
let editor: SceneEditor,
  revision = "new",
  selection = "",
  instance: SceneInstance | null = null;
const endpoint = () =>
  `scene?name=${encodeURIComponent(element<HTMLInputElement>("file").value)}`;
const find = (node: SceneNodeData, id: string): SceneNodeData | undefined =>
  node.id === id ? node : node.children?.map((c) => find(c, id)).find(Boolean);
function refresh(reframe = true) {
  // Validate and construct first; a bad edit must not erase the last working preview.
  const next = registry.instantiate(editor.document);
  instance?.dispose();
  instance = next;
  scene.world3D.clear();
  scene.world.clear();
  if (next.root instanceof Node3D) scene.world3D.add(next.root);
  else scene.world.add(next.root);
  if (next.root instanceof Node3D) {
    next.root.updateWorldTree();
    const min = new Vec3(Infinity, Infinity, Infinity),
      max = new Vec3(-Infinity, -Infinity, -Infinity),
      point = new Vec3();
    for (const node of next.nodes.values())
      if (node instanceof Mesh3D) {
        const p = node.geometry.positions;
        for (let i = 0; i < p.length; i += 3) {
          mat4Point(
            node.worldMatrix,
            point.set(p[i], p[i + 1], p[i + 2]),
            point,
          );
          min.x = Math.min(min.x, point.x);
          min.y = Math.min(min.y, point.y);
          min.z = Math.min(min.z, point.z);
          max.x = Math.max(max.x, point.x);
          max.y = Math.max(max.y, point.y);
          max.z = Math.max(max.z, point.z);
        }
      }
    if (reframe && Number.isFinite(min.x)) {
      focus.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
      distance = Math.max(
        4,
        Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) * 1.2,
      );
    }
  }
  renderer.collectGarbage();
  const tree = element("tree");
  tree.replaceChildren();
  const add = (node: SceneNodeData, depth = 0) => {
    const b = document.createElement("button");
    b.dataset.nodeId = node.id;
    b.textContent = `${"  ".repeat(depth)}${node.name ?? node.id} · ${node.type ?? node.prefab}`;
    b.onclick = () => {
      selection = node.id;
      inspect();
    };
    tree.append(b);
    for (const c of node.children ?? []) add(c, depth + 1);
  };
  add(editor.document.root);
  if (!find(editor.document.root, selection))
    selection = editor.document.root.id;
  inspect();
  element<HTMLTextAreaElement>("source").value = editor.serialize();
}
function inspect() {
  const node = find(editor.document.root, selection)!;
  for (const button of element("tree").querySelectorAll("button")) button.setAttribute("aria-current", String((button as HTMLButtonElement).dataset.nodeId === selection));
  element<HTMLInputElement>("name").value = node.name ?? node.id;
  const position = Array.isArray(node.props?.position) && node.props.position.length === 3 ? node.props.position : [0, 0, 0];
  for (const [i, key] of ["tx", "ty", "tz"].entries()) element<HTMLInputElement>(key).value = String(position[i]);
  const rotation = Array.isArray(node.props?.rotation) && node.props.rotation.length === 3 ? node.props.rotation : [0, 0, 0];
  for (const [i, key] of ["rx", "ry", "rz"].entries()) element<HTMLInputElement>(key).value = String(Math.round(Number(rotation[i]) * 180 / Math.PI * 100) / 100);
  const scale = Array.isArray(node.props?.scale) && node.props.scale.length === 3 ? node.props.scale : [1, 1, 1];
  for (const [i, key] of ["sx", "sy", "sz"].entries()) element<HTMLInputElement>(key).value = String(scale[i]);
  const movable = !!node.type && ["Node3D", "Mesh3D", "PointLight3D"].includes(node.type);
  element("transform").hidden = !movable;
  element<HTMLButtonElement>("apply-transform").hidden = !movable;
  element<HTMLTextAreaElement>("props").value = JSON.stringify(
    node.props ?? {},
    null,
    2,
  );
}
function action(fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      status((e as Error).message);
    }
  };
}
element("load").onclick = action(async () => {
  const response = await fetch(endpoint());
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  editor = new SceneEditor(data.document);
  revision = data.revision;
  refresh();
  status("Loaded. Edits are local until saved.");
});
element("save").onclick = action(async () => {
  const response = await fetch(endpoint(), {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": revision },
    body: editor.serialize(),
  });
  if (!response.ok) throw new Error(await response.text());
  revision = (await response.json()).revision;
  status("Saved to project.");
});
element("apply").onclick = action(() => {
  const props = JSON.parse(element<HTMLTextAreaElement>("props").value),
    name = element<HTMLInputElement>("name").value;
  editor.edit((d) => {
    const node = find(d.root, selection)!;
    node.props = props;
    node.name = name;
  });
  refresh();
  status("Properties applied. Save to keep them.");
});
element("apply-transform").onclick = action(() => {
  const position = ["tx", "ty", "tz"].map((id) => Number(element<HTMLInputElement>(id).value));
  const degrees = ["rx", "ry", "rz"].map((id) => Number(element<HTMLInputElement>(id).value));
  const scale = ["sx", "sy", "sz"].map((id) => Number(element<HTMLInputElement>(id).value));
  if (![...position, ...degrees, ...scale].every(Number.isFinite)) throw new Error("Transform values must be finite numbers");
  if (scale.some((value) => Math.abs(value) < 1e-6)) throw new Error("Scale axes must be nonzero");
  const rotation = degrees.map((value) => value * Math.PI / 180);
  editor.edit((d) => {
    const node = find(d.root, selection)!;
    node.props = { ...node.props, position, rotation, scale };
  });
  refresh(false);
  status("Transform applied. Save to keep it.");
});
element("undo").onclick = action(() => {
  editor.undo();
  refresh();
});
element("redo").onclick = action(() => {
  editor.redo();
  refresh();
});
element("add").onclick = action(() => {
  editor.edit((d) => {
    let n = 1;
    while (find(d.root, `box${n}`)) n++;
    const parent = find(d.root, selection)!;
    (parent.children ??= []).push({
      id: `box${n}`,
      type: "Mesh3D",
      props: {
        primitive: "box",
        position: [0, 0.5, 0],
        color: 0x6fbaae,
        shading: "lambert",
        toneMapped: false,
      },
    });
    selection = `box${n}`;
  });
  refresh();
});
element("delete").onclick = action(() => {
  if (selection === editor.document.root.id)
    throw new Error("Cannot delete the scene root");
  editor.edit((d) => {
    const remove = (n: SceneNodeData) => {
      n.children = n.children?.filter((c) => c.id !== selection);
      for (const c of n.children ?? []) remove(c);
    };
    remove(d.root);
  });
  refresh();
});
element("replace").onclick = action(() => {
  const next = JSON.parse(element<HTMLTextAreaElement>("source").value);
  editor.edit((d) => {
    for (const key of Object.keys(d))
      delete (d as unknown as Record<string, unknown>)[key];
    Object.assign(d, next);
  });
  refresh();
});
const canvasPoint = (e: PointerEvent): [number, number] => {
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) * 800 / rect.width, (e.clientY - rect.top) * 600 / rect.height];
};
interface Placement {
  id: string;
  node: Node3D;
  start: Vec3;
  world: Vec3;
  initial: Vec3;
  changed: boolean;
}
let dragging = false, lastX = 0, placement: Placement | null = null;
canvas.onpointerdown = (e) => {
  if (e.button !== 0 || !editor || !instance) return;
  const [x, y] = canvasPoint(e);
  if (e.shiftKey) {
    const data = find(editor.document.root, selection), node = instance.nodes.get(selection);
    if (data?.type && node instanceof Node3D) {
      const world = node.getWorldPosition(), start = scene.camera3D.screenToGround(x, y, 800, 600, world.y);
      if (start) {
        placement = { id: selection, node, start, world, initial: node.position.clone(), changed: false };
        canvas.setPointerCapture(e.pointerId);
        status(`Moving ${data.name ?? data.id}. Release to commit; Escape cancels.`);
        return;
      }
    }
  }
  const hit = pickSceneMesh(instance.nodes, scene.camera3D, x, y, 800, 600);
  if (hit) { selection = hit.id; inspect(); }
  dragging = true;
  lastX = e.clientX;
  canvas.setPointerCapture(e.pointerId);
};
function finishPlacement(commit: boolean) {
  const move = placement;
  placement = null;
  dragging = false;
  if (!move) return;
  if (!commit || !move.changed) {
    move.node.position.copy(move.initial);
    status(commit ? "Position unchanged." : "Move cancelled.");
    return;
  }
  const position = [move.node.x, move.node.y, move.node.z];
  editor.edit((d) => {
    const node = find(d.root, move.id);
    if (!node?.type) throw new Error("Selected node is no longer editable");
    node.props = { ...node.props, position };
  });
  refresh(false);
  status("Position changed. Save to keep it.");
}
canvas.onpointerup = () => finishPlacement(true);
canvas.onpointercancel = () => finishPlacement(false);
canvas.onpointermove = (e) => {
  if (placement) {
    const [x, y] = canvasPoint(e);
    const hit = scene.camera3D.screenToGround(x, y, 800, 600, placement.world.y);
    if (!hit) return;
    const world = placement.world.clone().add(hit.sub(placement.start));
    try {
      placement.node.position.copy(worldPointInParent(placement.node, world));
      placement.changed = true;
      const local = placement.node.position;
      for (const [i, key] of ["tx", "ty", "tz"].entries()) element<HTMLInputElement>(key).value = [local.x, local.y, local.z][i].toFixed(2);
    } catch (error) { status((error as Error).message); finishPlacement(false); }
  } else if (dragging) {
    yaw += (e.clientX - lastX) * 0.01;
    lastX = e.clientX;
  }
};
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && placement) { finishPlacement(false); e.preventDefault(); } });
canvas.onwheel = (e) => {
  e.preventDefault();
  distance = Math.max(2, Math.min(80, distance + e.deltaY * 0.02));
};
let frame = 0;
function draw() {
  scene.camera3D.position.set(
    focus.x + Math.sin(yaw) * distance,
    focus.y + distance * 0.6,
    focus.z + Math.cos(yaw) * distance,
  );
  scene.camera3D.lookAt(focus.x, focus.y, focus.z);
  const selected = instance?.nodes.get(selection), gizmo = element<HTMLDivElement>("gizmo");
  if (selected instanceof Node3D) {
    const p = scene.camera3D.project(selected.getWorldPosition(), 800, 600);
    gizmo.hidden = p.z < -1 || p.z > 1 || p.x < 0 || p.x > 800 || p.y < 0 || p.y > 600;
    gizmo.style.left = `${p.x / 8}%`;
    gizmo.style.top = `${p.y / 6}%`;
  } else gizmo.hidden = true;
  renderer.begin(0x14252c);
  if (instance?.root instanceof Node3D)
    renderer.render3D(scene.collectFrame3D());
  else scene.drawTree(context);
  renderer.end(post);
  if (frame++ % 30 === 0)
    element("diagnostics").textContent = JSON.stringify(
      renderer.diagnostics,
      null,
      2,
    );
  requestAnimationFrame(draw);
}
element("load").click();
draw();
window.addEventListener("beforeunload", () => {
  instance?.dispose();
  renderer.destroy();
});
