// Geometry checks for authored UI. Run after a rendered frame so layout containers
// and scroll offsets have settled. This is intentionally a diagnostic, not a layout
// engine: overlays may overlap by design and can be exempted by the caller.

import type { Rect } from "../core/math.ts";
import { type Mat, matApply, matCompose, matIdentity, matMul } from "../render/types.ts";
import { Node, Node2D } from "../scene/node.ts";
import type { Scene } from "../scene/scene.ts";
import { Control } from "../scene/ui.ts";
import { ScrollContainer } from "../scene/widgets.ts";

export interface UILayoutIssue {
  kind: "outside" | "overlap" | "invalid-size";
  controls: Control[];
  /** Visible screen-space rectangle of the first control, when measurable. */
  rect?: Rect;
}

export interface UILayoutAuditOptions {
  /** Ignore a control entirely, for example a deliberately off-screen transition. */
  ignore?: (control: Control) => boolean;
  /** Permit deliberate overlaps such as stacked cards or modal backdrops. */
  allowOverlap?: (a: Control, b: Control) => boolean;
  /** Maximum tolerated spill in logical screen pixels. Defaults to 0.5 for rounding. */
  tolerance?: number;
}

type Entry = { control: Control; rect: Rect };

function transformedRect(m: Readonly<Mat>, w: number, h: number): Rect {
  const corners = [matApply(m, 0, 0), matApply(m, w, 0), matApply(m, 0, h), matApply(m, w, h)];
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

function isAncestor(a: Node, b: Node): boolean {
  for (let p = b.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/**
 * Find controls outside the fitted UI viewport, invalid target sizes and visible
 * intersections between unrelated controls. Scroll contents are checked only where
 * actually visible; hidden subtrees are skipped. Rectangles are axis-aligned bounds,
 * so callers should exempt deliberate rotated/stacked overlaps.
 */
export function auditUILayout(scene: Scene, opts: UILayoutAuditOptions = {}): UILayoutIssue[] {
  const issues: UILayoutIssue[] = [];
  const entries: Entry[] = [];
  const root = scene.ui;
  const rootMatrix = matCompose(matIdentity(), root.x, root.y, root.scaleX, root.scaleY, root.rotation);
  const viewport = transformedRect(rootMatrix, scene.uiWidth, scene.uiHeight);
  const tolerance = opts.tolerance ?? 0.5;

  function visit(node: Node, parentMatrix: Readonly<Mat>, clip: Rect | null): void {
    if (!node.visible) return;
    let matrix = parentMatrix;
    if (node instanceof Node2D) {
      const local = matCompose(matIdentity(), node.x, node.y, node.scaleX, node.scaleY, node.rotation);
      matrix = matMul(matIdentity(), parentMatrix, local);
    }
    let nextClip = clip;
    if (node instanceof Control && !opts.ignore?.(node)) {
      if (!Number.isFinite(node.w) || !Number.isFinite(node.h) || node.w <= 0 || node.h <= 0) {
        issues.push({ kind: "invalid-size", controls: [node] });
      } else {
        const bounds = transformedRect(matrix, node.w, node.h);
        const visible = clip ? intersection(bounds, clip) : bounds;
        if (visible) {
          entries.push({ control: node, rect: visible });
          if (visible.x < viewport.x - tolerance || visible.y < viewport.y - tolerance ||
              visible.x + visible.w > viewport.x + viewport.w + tolerance ||
              visible.y + visible.h > viewport.y + viewport.h + tolerance)
            issues.push({ kind: "outside", controls: [node], rect: visible });
        }
      }
    }
    if (node instanceof ScrollContainer) {
      const bounds = transformedRect(matrix, node.w, node.h);
      nextClip = clip ? intersection(clip, bounds) : bounds;
      if (!nextClip) return;
    }
    for (const child of node.children) visit(child, matrix, nextClip);
  }

  for (const child of root.children) visit(child, rootMatrix, null);
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const a = entries[i], b = entries[j];
    if (isAncestor(a.control, b.control) || isAncestor(b.control, a.control)) continue;
    if (opts.allowOverlap?.(a.control, b.control)) continue;
    const shared = intersection(a.rect, b.rect);
    if (shared && shared.w > tolerance && shared.h > tolerance)
      issues.push({ kind: "overlap", controls: [a.control, b.control], rect: shared });
  }
  return issues;
}
