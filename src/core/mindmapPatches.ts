/**
 * Patch rules for mindmaps: every UI action becomes a small set of text
 * changes (ADR-001), like `patches.ts` does for flowcharts.
 *
 * In a mindmap the indentation is the structure, so adding, moving and
 * deleting work on whole lines and their subtrees. Canonical style for
 * inserted code: two more spaces than the parent (or the indentation of its
 * existing children), plain text for default nodes and `[Text]` (no id) for
 * other shapes.
 */

import {
  MINDMAP_DELIMS,
  subtreeIds,
  type Mindmap,
  type MindmapNode,
  type MindmapShape,
} from "./mindmap";
import { deleteLine, mergeOverlaps, type Change } from "./patches";

const UNIT = "  ";
export const NEW_IDEA = "New idea";

const find = (d: Mindmap, id: string) => d.nodes.find((n) => n.id === id);

/** Default nodes can't hold brackets, so they become entity codes. */
export function formatDefaultText(label: string): string {
  return label
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[()[\]{}]/g, (c) => `#${c.charCodeAt(0)};`);
}

/** Text inside delimiters is quoted when it holds a closing bracket or a quote. */
export function formatShapeText(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return /[()[\]{}"]/.test(clean)
    ? `"${clean.replace(/"/g, "#quot;")}"`
    : clean;
}

function formatNode(label: string, shape: MindmapShape): string {
  if (shape === "default") return formatDefaultText(label);
  const [open, close] = MINDMAP_DELIMS[shape];
  return `${open}${formatShapeText(label)}${close}`;
}

/** The indentation step used in the text: first child minus its parent, else two spaces. */
function unit(d: Mindmap): string {
  for (const n of d.nodes) {
    if (!n.parent) continue;
    const p = find(d, n.parent)!;
    if (n.indent.startsWith(p.indent) && n.indent.length > p.indent.length)
      return n.indent.slice(p.indent.length);
  }
  return UNIT;
}

/** Indentation for a new child of `parent`: like its siblings, else one step deeper. */
function childIndent(d: Mindmap, parent: MindmapNode, except?: string): string {
  const sibling = parent.children.find((c) => c !== except);
  return sibling ? find(d, sibling)!.indent : parent.indent + unit(d);
}

/**
 * A single change turning `before` into `after`, trimmed to the part that
 * actually differs. Used for moves, which are easier to express as "cut here,
 * paste there" on the whole text.
 */
function diff(before: string, after: string): Change[] {
  if (before === after) return [];
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  return [{ from: start, to: endB, insert: after.slice(start, endA) }];
}

export interface AddResult {
  changes: Change[];
  /** ID of the new node in the patched text. */
  id: string;
}

/** Number of nodes that start before `at`, i.e. the index a node inserted there gets. */
const indexAt = (d: Mindmap, at: number) =>
  d.nodes.filter((n) => n.span.from < at).length;

function insertAfter(
  d: Mindmap,
  at: number,
  indent: string,
  label: string,
): AddResult {
  return {
    changes: [
      {
        from: at,
        to: at,
        insert: `\n${indent}${formatNode(label, "default")}`,
      },
    ],
    id: `n${indexAt(d, at)}`,
  };
}

/**
 * Adds a node as the last child of `parentId`. Without a parent (or in an
 * empty mindmap) it adds a child to the root, or the root itself.
 */
export function addMindmapChild(
  text: string,
  d: Mindmap,
  parentId: string | undefined,
  label = NEW_IDEA,
): AddResult {
  const root = d.nodes[0];
  if (!root) {
    const at = d.headerSpan?.to ?? text.replace(/\s+$/, "").length;
    const indent = d.headerSpan
      ? /^[ \t]*/.exec(
          text.slice(text.lastIndexOf("\n", d.headerSpan.from - 1) + 1),
        )![0] + UNIT
      : UNIT;
    return insertAfter(d, at, indent, label);
  }
  const parent = (parentId && find(d, parentId)) || root;
  return insertAfter(d, parent.block.to, childIndent(d, parent), label);
}

/** Adds a node right after `id` (and its subtree), on the same level. The root gets a child instead. */
export function addMindmapSibling(
  text: string,
  d: Mindmap,
  id: string,
  label = NEW_IDEA,
): AddResult {
  const node = find(d, id);
  if (!node || !node.parent) return addMindmapChild(text, d, node?.id, label);
  return insertAfter(d, node.block.to, node.indent, label);
}

export function setMindmapText(
  d: Mindmap,
  id: string,
  label: string,
): Change[] {
  const node = find(d, id);
  const clean = label.replace(/\s+/g, " ").trim();
  if (!node || !clean || clean === node.label) return [];
  const insert =
    node.shape === "default"
      ? formatDefaultText(clean)
      : formatShapeText(clean);
  return [{ from: node.textSpan.from, to: node.textSpan.to, insert }];
}

/**
 * Changes a node's shape. Between bracket shapes only the delimiters change
 * (an id like `root` in `root((x))` is kept). To and from the default shape the
 * node is rewritten, because the default shape has no id or brackets.
 */
export function setMindmapShape(
  d: Mindmap,
  id: string,
  shape: MindmapShape,
): Change[] {
  const node = find(d, id);
  if (!node || node.shape === shape) return [];
  if (node.shape !== "default" && shape !== "default") {
    const [open, close] = MINDMAP_DELIMS[shape];
    const { delims } = node;
    return [
      { from: delims!.open.from, to: delims!.open.to, insert: open },
      { from: delims!.close.from, to: delims!.close.to, insert: close },
    ];
  }
  return [
    {
      from: node.span.from,
      to: node.span.to,
      insert: formatNode(node.label, shape),
    },
  ];
}

export interface DeleteResult {
  changes: Change[];
  error?: string;
}

/** Deletes nodes with their whole subtree. The root stays: without it the children would all be roots. */
export function deleteMindmapNodes(
  text: string,
  d: Mindmap,
  ids: Iterable<string>,
): DeleteResult {
  const changes: Change[] = [];
  let skippedRoot = false;
  for (const id of ids) {
    const node = find(d, id);
    if (!node) continue;
    if (!node.parent) {
      skippedRoot = true;
      continue;
    }
    changes.push(deleteLine(text, node.block.from, node.block.to));
  }
  return {
    changes: mergeOverlaps(changes),
    error: skippedRoot
      ? "The root can't be deleted, it holds the whole mindmap"
      : undefined,
  };
}

/** The lines of a node's block, re-indented so the node itself gets `indent`. */
function reindent(text: string, node: MindmapNode, indent: string): string {
  return text
    .slice(node.block.from, node.block.to)
    .split("\n")
    .map((l) =>
      l.startsWith(node.indent)
        ? indent + l.slice(node.indent.length)
        : l.trim()
          ? indent + l.trimStart()
          : l,
    )
    .join("\n");
}

/** Removes a block (with its line break) and returns the text and where it was. */
function cut(text: string, node: MindmapNode) {
  const c = deleteLine(text, node.block.from, node.block.to);
  return {
    rest: text.slice(0, c.from) + text.slice(c.to),
    /** Maps an offset in `text` (outside the block) into `rest`. */
    map: (at: number) => (at <= c.from ? at : at - (c.to - c.from)),
  };
}

export interface MoveResult {
  changes: Change[];
  error?: string;
}

/** Moves a node with its subtree to be the last child of `parentId`. */
export function moveMindmapNode(
  text: string,
  d: Mindmap,
  id: string,
  parentId: string,
): MoveResult {
  const node = find(d, id);
  const parent = find(d, parentId);
  if (!node || !parent || node.parent === parentId) return { changes: [] };
  if (!node.parent) return { changes: [], error: "The root can't be moved" };
  if (subtreeIds(d, id).has(parentId))
    return { changes: [], error: "Can't move a node into its own branch" };

  const block = reindent(text, node, childIndent(d, parent, id));
  const { rest, map } = cut(text, node);
  // The parent's block may end with the moved node; then it ends where the cut starts.
  const end =
    parent.block.to === node.block.to
      ? map(lastLineEndBefore(text, node.block.from))
      : map(parent.block.to);
  return {
    changes: diff(text, rest.slice(0, end) + "\n" + block + rest.slice(end)),
  };
}

/** End of the last non-empty line before `at`. */
function lastLineEndBefore(text: string, at: number): number {
  return text.slice(0, at).replace(/\s+$/, "").length;
}

/** Swaps a node (with its subtree) with its previous (-1) or next (+1) sibling. */
export function moveMindmapSibling(
  text: string,
  d: Mindmap,
  id: string,
  delta: -1 | 1,
): Change[] {
  const node = find(d, id);
  if (!node?.parent) return [];
  const siblings = find(d, node.parent)!.children;
  const other = find(d, siblings[siblings.indexOf(id) + delta] ?? "");
  if (!other) return [];
  const [first, second] = delta < 0 ? [other, node] : [node, other];
  const a = text.slice(first.block.from, first.block.to);
  const b = text.slice(second.block.from, second.block.to);
  const between = text.slice(first.block.to, second.block.from);
  return diff(
    text,
    text.slice(0, first.block.from) +
      b +
      between +
      a +
      text.slice(second.block.to),
  );
}

/** ID of `id` after `moveMindmapSibling`, so the selection can follow. */
export function idAfterSiblingMove(
  d: Mindmap,
  id: string,
  delta: -1 | 1,
): string | undefined {
  const node = find(d, id);
  if (!node?.parent) return undefined;
  const siblings = find(d, node.parent)!.children;
  const other = find(d, siblings[siblings.indexOf(id) + delta] ?? "");
  if (!other) return undefined;
  const size = (n: MindmapNode) => subtreeIds(d, n.id).size;
  const index = Number(id.slice(1));
  return `n${delta < 0 ? index - size(other) : index + size(other)}`;
}
