/**
 * Auto-placement with dagre, the same layout engine Mermaid uses by default.
 *
 * Stored positions always win (ADR-002). dagre is only used to
 *  - lay out a diagram that has no positions at all,
 *  - place new nodes that have no position yet, close to their neighbours,
 *  - re-layout everything when the user asks for it.
 *
 * Positions are top-left corners, like in React Flow.
 */

import dagre from "@dagrejs/dagre";
import type { FlowNode } from "./flowchart";
import { displayMember, type ClassNode } from "./classDiagram";
import type { Diagram } from "./diagram";
import type { Layout, Pos } from "./layoutBlock";

export interface Size {
  w: number;
  h: number;
}

export function nodeSize(node: Pick<FlowNode, "label" | "shape">): Size {
  const lines = node.label.split(/<br\s*\/?>|\n/i);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const w = Math.max(80, Math.round(longest * 7.6 + 36));
  const h = 22 * lines.length + 22;
  switch (node.shape) {
    case "circle":
    case "double-circle": {
      const d = Math.max(w * 0.8, h, 64);
      return { w: d, h: d };
    }
    case "diamond":
      return { w: Math.round(w * 1.25), h: Math.max(64, Math.round(h * 1.6)) };
    case "hexagon":
      return { w: w + 24, h };
    default:
      return { w, h };
  }
}

/** Box metrics of a UML class, shared with the canvas so sizes match exactly. */
export const CLASS_BOX = {
  header: 32,
  annotation: 14,
  row: 20,
  /** Vertical padding of a compartment; an empty one is just this high. */
  pad: 6,
  charW: 7.3,
  nameCharW: 8.2,
  minW: 120,
} as const;

export function classNodeSize(
  node: Pick<ClassNode, "label" | "annotation" | "members">,
): Size {
  const B = CLASS_BOX;
  const texts = node.members.map((m) => displayMember(m.text).text);
  const w = Math.max(
    B.minW,
    Math.round(node.label.length * B.nameCharW + 32),
    ...texts.map((t) => Math.round(t.length * B.charW + 24)),
  );
  const attrs = node.members.filter((m) => m.kind === "attribute").length;
  const methods = node.members.length - attrs;
  const h =
    B.header +
    (node.annotation ? B.annotation : 0) +
    2 * B.pad +
    (attrs + methods) * B.row +
    2 * B.pad;
  return { w, h };
}

/** Size of any diagram node. */
export function sizeOf(node: FlowNode | ClassNode): Size {
  return "members" in node ? classNodeSize(node) : nodeSize(node);
}

function dagreLayout(fc: Diagram): Layout {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: fc.direction,
    nodesep: 50,
    ranksep: 60,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of fc.nodes) {
    const s = sizeOf(n);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of fc.edges) g.setEdge(e.from, e.to, {}, e.id);
  dagre.layout(g);

  const out: Layout = {};
  for (const n of fc.nodes) {
    const d = g.node(n.id);
    const s = sizeOf(n);
    out[n.id] = { x: Math.round(d.x - s.w / 2), y: Math.round(d.y - s.h / 2) };
  }
  return out;
}

export function autoLayoutAll(fc: Diagram): Layout {
  return fc.nodes.length ? dagreLayout(fc) : {};
}

/** Returns positions for the nodes that don't have one yet (empty if none are missing). */
export function placeMissing(fc: Diagram, layout: Layout): Layout {
  const missing = fc.nodes.filter((n) => !layout[n.id]);
  if (missing.length === 0) return {};
  const placedCount = fc.nodes.length - missing.length;
  const ideal = dagreLayout(fc);
  if (placedCount === 0) return ideal;

  const sizes = new Map<string, Size>(fc.nodes.map((n) => [n.id, sizeOf(n)]));
  const rects: { pos: Pos; size: Size }[] = fc.nodes
    .filter((n) => layout[n.id])
    .map((n) => ({ pos: layout[n.id], size: sizes.get(n.id)! }));

  const neighbours = new Map<string, string[]>();
  for (const e of fc.edges) {
    // Prefer predecessors: a new node usually hangs off an existing one.
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
  }

  const known: Layout = { ...layout };
  const out: Layout = {};
  const bounds = boundingBox(rects);
  const horizontal = fc.direction === "LR" || fc.direction === "RL";

  for (const n of missing) {
    const anchor = (neighbours.get(n.id) ?? []).find((id) => known[id]);
    let pos: Pos;
    if (anchor) {
      // Keep dagre's relative offset to the anchor, applied to the anchor's real position.
      pos = {
        x: known[anchor].x + (ideal[n.id].x - ideal[anchor].x),
        y: known[anchor].y + (ideal[n.id].y - ideal[anchor].y),
      };
    } else if (horizontal) {
      pos = { x: bounds.x, y: bounds.y + bounds.h + 40 };
    } else {
      pos = { x: bounds.x + bounds.w + 40, y: bounds.y };
    }
    pos = avoidOverlap(pos, sizes.get(n.id)!, rects, horizontal);
    rects.push({ pos, size: sizes.get(n.id)! });
    known[n.id] = pos;
    out[n.id] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  return out;
}

function boundingBox(rects: { pos: Pos; size: Size }[]) {
  const minX = Math.min(...rects.map((r) => r.pos.x));
  const minY = Math.min(...rects.map((r) => r.pos.y));
  const maxX = Math.max(...rects.map((r) => r.pos.x + r.size.w));
  const maxY = Math.max(...rects.map((r) => r.pos.y + r.size.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function avoidOverlap(
  pos: Pos,
  size: Size,
  rects: { pos: Pos; size: Size }[],
  horizontal: boolean,
): Pos {
  const gap = 20;
  const hits = (p: Pos) =>
    rects.some(
      (r) =>
        p.x < r.pos.x + r.size.w + gap &&
        p.x + size.w + gap > r.pos.x &&
        p.y < r.pos.y + r.size.h + gap &&
        p.y + size.h + gap > r.pos.y,
    );
  // Slide along the cross axis (down for LR, right for TB) until free.
  const p = { ...pos };
  for (let i = 0; i < 200 && hits(p); i++) {
    if (horizontal) p.y += size.h / 2 + gap / 2;
    else p.x += size.w / 2 + gap / 2;
  }
  return p;
}
