// The profiler: per-node update and render time, per-system frame sections, averaged over a
// window of frames. Off by default and free when off (one null check per node per frame).

import type { Node } from "../scene/node.ts";

export interface NodeProfile {
  /** The node's name, or its class when it has none. */
  name: string;
  /** Nodes that share the name. */
  count: number;
  /** Milliseconds per frame spent in `update`, averaged over the window. */
  updateMs: number;
  /** Milliseconds per frame spent in `render`, averaged over the window. */
  renderMs: number;
  /** Update plus render. */
  totalMs: number;
}

export interface ProfileReport {
  /** Frames averaged. */
  frames: number;
  /** Whole-frame CPU time in milliseconds. */
  frameMs: number;
  /** Per-system time: input, update, physics, tweens, draw, present. */
  sections: { name: string; ms: number }[];
  /** Node classes by total time, heaviest first. */
  nodes: NodeProfile[];
}

interface Acc {
  count: number;
  update: number;
  render: number;
}

/** The profiler nodes report to while one is enabled. */
export let activeProfiler: Profiler | null = null;

export class Profiler {
  /** Frames averaged in a report. */
  window = 60;
  private frames = 0;
  private frameMs = 0;
  private sections = new Map<string, number>();
  private sectionStart = new Map<string, number>();
  private nodes = new Map<string, Acc>();
  private frameNodes = new Set<string>();
  private counts = new Map<string, number>();
  private enabled = false;

  /** The clock; the App passes its platform's. Tests may swap in performance.now. */
  now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    activeProfiler = this;
    this.reset();
  }

  disable(): void {
    this.enabled = false;
    if (activeProfiler === this) activeProfiler = null;
  }

  toggle(): boolean {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  reset(): void {
    this.frames = 0;
    this.frameMs = 0;
    this.sections.clear();
    this.nodes.clear();
    this.counts.clear();
  }

  /** Start a frame; `endFrame` closes it. */
  beginFrame(): void {
    this.frameNodes.clear();
    this.sectionStart.set("frame", this.now());
    for (const [k, v] of this.counts) this.counts.set(k, 0);
    void this.counts;
  }

  endFrame(): void {
    const start = this.sectionStart.get("frame") ?? this.now();
    this.frameMs += this.now() - start;
    this.frames++;
    if (this.frames >= this.window * 2) this.decay();
  }

  /** Halve the accumulators so the report tracks recent frames rather than all time. */
  private decay(): void {
    this.frames = Math.floor(this.frames / 2);
    this.frameMs /= 2;
    for (const [k, v] of this.sections) this.sections.set(k, v / 2);
    for (const a of this.nodes.values()) {
      a.update /= 2;
      a.render /= 2;
    }
  }

  begin(section: string): void {
    this.sectionStart.set(section, this.now());
  }

  end(section: string): void {
    const start = this.sectionStart.get(section);
    if (start === undefined) return;
    this.sections.set(section, (this.sections.get(section) ?? 0) + (this.now() - start));
  }

  private acc(node: Node): Acc {
    const key = node.name || node.constructor.name || "Node";
    let a = this.nodes.get(key);
    if (!a) {
      a = { count: 0, update: 0, render: 0 };
      this.nodes.set(key, a);
    }
    const seen = this.counts.get(key) ?? 0;
    this.counts.set(key, seen + 1);
    if (seen + 1 > a.count) a.count = seen + 1;
    return a;
  }

  /** @internal Called by Node.updateTree while a profiler is active. */
  nodeUpdate(node: Node, ms: number): void {
    this.acc(node).update += ms;
  }

  /** @internal Called by Node.drawTree while a profiler is active. */
  nodeRender(node: Node, ms: number): void {
    const key = node.name || node.constructor.name || "Node";
    const a = this.nodes.get(key) ?? this.acc(node);
    a.render += ms;
  }

  report(limit = 12): ProfileReport {
    const n = Math.max(1, this.frames);
    const nodes: NodeProfile[] = [];
    for (const [name, a] of this.nodes) {
      nodes.push({ name, count: a.count, updateMs: a.update / n, renderMs: a.render / n, totalMs: (a.update + a.render) / n });
    }
    nodes.sort((x, y) => y.totalMs - x.totalMs);
    const sections = ["input", "update", "physics", "tweens", "draw", "present"].filter((s) => this.sections.has(s)).map((name) => ({ name, ms: (this.sections.get(name) ?? 0) / n }));
    return { frames: this.frames, frameMs: this.frameMs / n, sections, nodes: nodes.slice(0, limit) };
  }

  /** The report as text lines, for logs and the overlay. */
  lines(limit = 8): string[] {
    const r = this.report(limit);
    const out = [`frame ${r.frameMs.toFixed(2)} ms   ${r.sections.map((s) => `${s.name} ${s.ms.toFixed(2)}`).join("   ")}`];
    for (const nd of r.nodes) out.push(`${nd.name.padEnd(18).slice(0, 18)} x${String(nd.count).padStart(5)}  upd ${nd.updateMs.toFixed(2)}  draw ${nd.renderMs.toFixed(2)}`);
    return out;
  }
}
