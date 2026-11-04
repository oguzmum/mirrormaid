/**
 * Span-aware parser for Mermaid mindmaps (ADR-001, ADR-004).
 *
 * A mindmap is a tree written by indentation:
 *
 *   mindmap
 *     root((Project))          the first node is the root, any shape
 *       Goals                  default shape: plain text, the text is the id
 *         [Fast sketching]     shape without an id
 *         id(Rounded)          shape with an id
 *       ::icon(fa fa-flag)     decorations belong to the node above
 *       :::urgent
 *
 * Shapes: `[square]`, `(rounded)`, `((circle))`, `))bang((`, `)cloud(`,
 * `{{hexagon}}`. Like Mermaid, a node's parent is the closest node above it
 * with less indentation, and there can only be one root.
 *
 * Unlike the other diagram types, positions are not stored: a mindmap is laid
 * out from its structure (`mindmapLayout`), so node IDs only need to be stable
 * between two parses. They are the node's index in source order (`n0` is the root).
 */

import type { Direction, ParseError, Span } from "./flowchart";

export type MindmapShape =
  "default" | "square" | "rounded" | "circle" | "bang" | "cloud" | "hexagon";

export const MINDMAP_DELIMS: Record<
  Exclude<MindmapShape, "default">,
  [string, string]
> = {
  square: ["[", "]"],
  rounded: ["(", ")"],
  circle: ["((", "))"],
  bang: ["))", "(("],
  cloud: [")", "("],
  hexagon: ["{{", "}}"],
};

export interface MindmapNode {
  id: string;
  label: string;
  shape: MindmapShape;
  /** 0 for the root. */
  depth: number;
  parent?: string;
  children: string[];
  /** Index of the root's child this node hangs under (-1 for the root). */
  branch: number;
  /** Indentation of the node's line, as written. */
  indent: string;
  /** The node as written, without indentation. */
  span: Span;
  /** Text as written: between the delimiters (with quotes), or the whole node for the default shape. */
  textSpan: Span;
  /** Opening and closing delimiter, for shapes other than default. */
  delims?: { open: Span; close: Span };
  /**
   * From the start of the node's line to the end of the last line of its
   * subtree (children and decorations), so cutting it moves the whole branch.
   */
  block: Span;
}

export interface MindmapEdge {
  id: string;
  from: string;
  to: string;
}

export interface Mindmap {
  kind: "mindmap";
  ok: boolean;
  /** Mindmaps grow to both sides; this only exists so layout code can treat all diagrams alike. */
  direction: Direction;
  headerSpan?: Span;
  /** In source order; the root comes first. */
  nodes: MindmapNode[];
  /** Parent → child, one per non-root node. */
  edges: MindmapEdge[];
  /** Decoration lines (`::icon(...)`, `:::class`), kept as they are. */
  passthrough: Span[];
  errors: ParseError[];
}

const HEADER = /^mindmap[ \t]*$/;
/** Openers in the order Mermaid's lexer tries them. */
const OPENERS: [string, MindmapShape][] = [
  ["))", "bang"],
  [")", "cloud"],
  ["((", "circle"],
  ["{{", "hexagon"],
  ["(", "rounded"],
  ["[", "square"],
];
/** Mermaid's NODE_ID: everything up to a bracket. */
const NODE_ID = /^[^([)\]{}]+/;

/** Turns `#quot;` and numeric entity codes back into characters. */
export function decodeMindmapText(raw: string): string {
  return raw
    .replace(/#quot;/g, '"')
    .replace(/#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function readText(raw: string): string {
  const t = raw.trim();
  if (/^"`[\s\S]*`"$/.test(t)) return decodeMindmapText(t.slice(2, -2));
  if (/^"[\s\S]*"$/.test(t) && t.length >= 2)
    return decodeMindmapText(t.slice(1, -1));
  return decodeMindmapText(t);
}

interface NodeSyntax {
  shape: MindmapShape;
  /** Offsets relative to the start of the node text. */
  text: [number, number];
  delims?: { open: [number, number]; close: [number, number] };
}

/** Reads one node (`Text`, `id[Text]`, `((Text))`, ...), or undefined if it isn't one. */
function readNode(s: string): NodeSyntax | undefined {
  const idMatch = NODE_ID.exec(s);
  const idEnd = idMatch ? idMatch[0].length : 0;
  if (idEnd === s.length) return { shape: "default", text: [0, s.length] };

  const at = idEnd;
  const opener = OPENERS.find(([o]) => s.startsWith(o, at));
  if (!opener) return undefined;
  const [open, shape] = opener;
  const close = MINDMAP_DELIMS[shape as Exclude<MindmapShape, "default">][1];
  const textFrom = at + open.length;

  let textTo: number;
  if (s.startsWith('"`', textFrom)) {
    const end = s.indexOf('`"', textFrom + 2);
    if (end === -1) return undefined;
    textTo = end + 2;
  } else if (s[textFrom] === '"') {
    const end = s.indexOf('"', textFrom + 1);
    if (end === -1) return undefined;
    textTo = end + 1;
  } else {
    const m = /^[^)\](}]*/.exec(s.slice(textFrom))!;
    textTo = textFrom + m[0].length;
  }
  if (!s.startsWith(close, textTo)) return undefined;
  const closeTo = textTo + close.length;
  if (s.slice(closeTo).trim() !== "") return undefined;
  if (s.slice(textFrom, textTo).trim() === "") return undefined;
  return {
    shape,
    text: [textFrom, textTo],
    delims: { open: [at, textFrom], close: [textTo, closeTo] },
  };
}

export function parseMindmap(text: string): Mindmap {
  const result: Mindmap = {
    kind: "mindmap",
    ok: false,
    direction: "LR",
    nodes: [],
    edges: [],
    passthrough: [],
    errors: [],
  };
  const error = (message: string, from: number, to: number) =>
    result.errors.push({ message, from, to });

  let headerSeen = false;
  /** Open ancestors: the last node at each indentation level. */
  const stack: MindmapNode[] = [];
  const byId = new Map<string, MindmapNode>();

  /** Extends the block of the current node and all its ancestors to `to`. */
  const extend = (to: number) => {
    for (const n of stack) n.block.to = to;
  };

  let pos = 0;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const raw = text.slice(pos, lineEnd);
    const indent = /^[ \t]*/.exec(raw)![0];
    const line = raw.trim();
    const from = pos + indent.length;
    const to = from + line.length;

    if (line === "" || line.startsWith("%%")) {
      // empty or comment
    } else if (!headerSeen) {
      if (HEADER.test(line)) {
        headerSeen = true;
        result.headerSpan = { from, to };
      } else {
        error("Expected `mindmap` header", from, to);
        break;
      }
    } else if (line.startsWith("::icon(") || line.startsWith(":::")) {
      if (!stack.length) error("Icon or class before the first node", from, to);
      else if (line.startsWith("::icon(") && !line.endsWith(")"))
        error("Missing `)` after the icon", from, to);
      else {
        result.passthrough.push({ from, to });
        extend(to);
      }
    } else {
      const syntax = readNode(line);
      if (!syntax) {
        error(
          "Unrecognized node: use `Text`, `[Text]`, `(Text)`, `((Text))`, `))Text((`, `)Text(` or `{{Text}}`",
          from,
          to,
        );
      } else {
        const level = indent.length;
        while (stack.length && stack[stack.length - 1].indent.length >= level)
          stack.pop();
        const parent = stack[stack.length - 1];
        if (!parent && result.nodes.length) {
          error(
            "A mindmap has only one root: indent this line more than the root",
            from,
            to,
          );
        } else {
          const at = (r: [number, number]): Span => ({
            from: from + r[0],
            to: from + r[1],
          });
          const node: MindmapNode = {
            id: `n${result.nodes.length}`,
            label: readText(line.slice(syntax.text[0], syntax.text[1])),
            shape: syntax.shape,
            depth: parent ? parent.depth + 1 : 0,
            parent: parent?.id,
            children: [],
            branch: !parent
              ? -1
              : parent.depth === 0
                ? parent.children.length
                : parent.branch,
            indent,
            span: { from, to },
            textSpan: at(syntax.text),
            delims: syntax.delims && {
              open: at(syntax.delims.open),
              close: at(syntax.delims.close),
            },
            block: { from: pos, to },
          };
          if (parent) {
            parent.children.push(node.id);
            result.edges.push({
              id: `${parent.id}->${node.id}`,
              from: parent.id,
              to: node.id,
            });
          }
          result.nodes.push(node);
          byId.set(node.id, node);
          stack.push(node);
          extend(to);
        }
      }
    }

    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }

  if (!headerSeen && result.errors.length === 0)
    error("Empty diagram: add a `mindmap` header", 0, 0);
  result.ok = result.errors.length === 0;
  return result;
}

/** The node and everything below it. */
export function subtreeIds(d: Mindmap, id: string): Set<string> {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const walk = (i: string) => {
    out.add(i);
    for (const c of byId.get(i)?.children ?? []) walk(c);
  };
  walk(id);
  return out;
}
