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
import type { StateNode } from "./stateDiagram";
import type { Mindmap, MindmapNode } from "./mindmap";
import type { Diagram } from "./diagram";
import type { Direction } from "./flowchart";
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

/**
 * Size of a state node. Fork/join bars lie across the flow, so they depend on
 * the direction.
 */
export function stateNodeSize(
  node: Pick<StateNode, "kind" | "label">,
  direction: Direction = "TB",
): Size {
  switch (node.kind) {
    case "start":
      return { w: 22, h: 22 };
    case "end":
      return { w: 26, h: 26 };
    case "choice":
      return { w: 36, h: 36 };
    case "fork":
    case "join":
      return direction === "LR" || direction === "RL"
        ? { w: 10, h: 80 }
        : { w: 80, h: 10 };
    default: {
      const s = nodeSize({ label: node.label, shape: "round" });
      return { w: Math.max(s.w, 90), h: Math.max(s.h, 40) };
    }
  }
}

/** Size of a mindmap node. The root is set in a larger font. */
export function mindmapNodeSize(
  node: Pick<MindmapNode, "label" | "shape" | "depth">,
): Size {
  const lines = node.label.split(/<br\s*\/?>|\n/i);
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const root = node.depth === 0;
  const textW = longest * (root ? 9 : 7.6);
  const textH = (root ? 24 : 20) * lines.length;
  switch (node.shape) {
    case "default":
      return { w: Math.max(48, Math.round(textW + 24)), h: textH + 14 };
    case "circle": {
      const d = Math.max(Math.round(textW * 0.9 + 24), textH + 28, 56);
      return { w: d, h: d };
    }
    case "bang":
    case "cloud":
      return {
        w: Math.max(80, Math.round(textW * 1.25 + 40)),
        h: Math.max(56, Math.round(textH * 1.6 + 24)),
      };
    case "hexagon":
      return { w: Math.max(64, Math.round(textW + 52)), h: textH + 22 };
    default:
      return { w: Math.max(56, Math.round(textW + 32)), h: textH + 22 };
  }
}

/** Gaps of the mindmap layout: between a node and its children, and between sibling branches. */
export const MINDMAP_GAP = { x: 48, y: 12 } as const;

/**
 * Lays out a mindmap like a tree growing to both sides of the root: the first
 * branches (by height) go right, the rest left, each read top to bottom in
 * source order. Every parent sits vertically centered on its children.
 * Positions are a pure function of the text, so they are not stored (README:
 * "mindmaps are laid out automatically").
 */
export function mindmapLayout(d: Mindmap): Layout {
  const root = d.nodes[0];
  if (!root) return {};
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const size = new Map(d.nodes.map((n) => [n.id, mindmapNodeSize(n)]));
  const heights = new Map<string, number>();
  const height = (id: string): number => {
    let h = heights.get(id);
    if (h === undefined) {
      const kids = byId.get(id)!.children;
      const kidsH = kids.reduce((s, k) => s + height(k), 0);
      h = Math.max(
        size.get(id)!.h,
        kidsH + Math.max(0, kids.length - 1) * MINDMAP_GAP.y,
      );
      heights.set(id, h);
    }
    return h;
  };

  const out: Layout = {};
  const rs = size.get(root.id)!;
  out[root.id] = { x: -Math.round(rs.w / 2), y: -Math.round(rs.h / 2) };

  /** Stacks `ids` beside the node at `parent`, centered on its middle. */
  const place = (ids: string[], parent: Pos, ps: Size, side: 1 | -1) => {
    const total =
      ids.reduce((s, k) => s + height(k), 0) +
      Math.max(0, ids.length - 1) * MINDMAP_GAP.y;
    let y = parent.y + ps.h / 2 - total / 2;
    for (const id of ids) {
      const s = size.get(id)!;
      const h = height(id);
      const pos = {
        x: Math.round(
          side > 0
            ? parent.x + ps.w + MINDMAP_GAP.x
            : parent.x - MINDMAP_GAP.x - s.w,
        ),
        y: Math.round(y + h / 2 - s.h / 2),
      };
      out[id] = pos;
      place(byId.get(id)!.children, pos, s, side);
      y += h + MINDMAP_GAP.y;
    }
  };

  // Fill the right side until it holds about half of the height.
  const kids = root.children;
  const total = kids.reduce((s, k) => s + height(k), 0);
  let right = 0;
  let acc = 0;
  while (
    right < kids.length &&
    (right === 0 || acc + height(kids[right]) / 2 <= total / 2)
  )
    acc += height(kids[right++]);
  place(kids.slice(0, right), out[root.id], rs, 1);
  place(kids.slice(right), out[root.id], rs, -1);
  return out;
}

/** Size of any diagram node. */
export function sizeOf(
  node: FlowNode | ClassNode | StateNode | MindmapNode,
  direction?: Direction,
): Size {
  if ("branch" in node) return mindmapNodeSize(node);
  if ("members" in node) return classNodeSize(node);
  if ("descriptions" in node) return stateNodeSize(node, direction);
  return nodeSize(node);
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
    const s = sizeOf(n, fc.direction);
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of fc.edges) g.setEdge(e.from, e.to, {}, e.id);
  dagre.layout(g);

  const out: Layout = {};
  for (const n of fc.nodes) {
    const d = g.node(n.id);
    const s = sizeOf(n, fc.direction);
    out[n.id] = { x: Math.round(d.x - s.w / 2), y: Math.round(d.y - s.h / 2) };
  }
  return out;
}

export function autoLayoutAll(fc: Diagram): Layout {
  if (fc.kind === "mindmap") return mindmapLayout(fc);
  return fc.nodes.length ? dagreLayout(fc) : {};
}

/** Returns positions for the nodes that don't have one yet (empty if none are missing). */
export function placeMissing(fc: Diagram, layout: Layout): Layout {
  if (fc.kind === "mindmap") return {}; // laid out from the text, never stored
  const missing = fc.nodes.filter((n) => !layout[n.id]);
  if (missing.length === 0) return {};
  const placedCount = fc.nodes.length - missing.length;
  const ideal = dagreLayout(fc);
  if (placedCount === 0) return ideal;

  const sizes = new Map<string, Size>(
    fc.nodes.map((n) => [n.id, sizeOf(n, fc.direction)]),
  );
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
