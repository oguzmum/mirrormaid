/**
 * Patch rules: every UI action becomes a small set of text changes (ADR-001).
 *
 * Changes are expressed against the visible code (without the layout block) and
 * never overlap, so they can be dispatched as one CodeMirror transaction and
 * end up on the editor's undo stack.
 *
 * Canonical style for inserted code: `    A[Label]` and `    A --> B`, using the
 * indentation of the existing statements.
 */

import {
  SHAPE_DELIMS,
  type FlowEdge,
  type Flowchart,
  type Link,
  type NodeRef,
  type Shape,
  type Statement,
  edgeLink,
} from "./flowchart";

export interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Writes a label so it survives the given shape's brackets. */
export function formatLabel(label: string, shape: Shape = "rect"): string {
  const [open, close] = SHAPE_DELIMS[shape];
  const needsQuotes =
    label !== label.trim() ||
    /[[\](){}<>|";`]/.test(label) ||
    /^[/\\]|[/\\]$/.test(label) ||
    label.includes(open) ||
    label.includes(close) ||
    /^(end|graph|flowchart|subgraph)$/i.test(label.trim());
  return needsQuotes ? `"${label.replace(/"/g, "#quot;")}"` : label;
}

function formatEdgeLabel(label: string): string {
  // `|` would end a pipe label, so it becomes Mermaid's entity code.
  const safe = label.replace(/\|/g, "#124;");
  return /"/.test(safe) || safe !== safe.trim()
    ? `"${safe.replace(/"/g, "#quot;")}"`
    : safe;
}

export function canonicalArrow(link: Link): string {
  const tail = link.tailArrow ? "<" : "";
  const head = { arrow: ">", cross: "x", circle: "o", none: "" }[link.head];
  switch (link.style) {
    case "thick":
      return tail + (head ? "==" : "===") + head;
    case "dotted":
      return tail + "-.-" + head;
    case "invisible":
      return "~~~";
    default:
      return tail + (head ? "--" : "---") + head;
  }
}

/** Indentation used for new lines: the one of the last statement, else 4 spaces. */
function statementIndent(text: string, fc: Flowchart): string {
  const last = fc.statements[fc.statements.length - 1];
  if (!last) return "    ";
  return lineIndent(text, last.span.from);
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function appendLine(text: string, fc: Flowchart, line: string): Change {
  const end = text.replace(/\s+$/, "").length;
  return {
    from: end,
    to: text.length,
    insert: `\n${statementIndent(text, fc)}${line}\n`,
  };
}

export function nextNodeId(fc: Flowchart): string {
  const taken = new Set(fc.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!taken.has(`n${i}`)) return `n${i}`;
}

// --- Nodes -------------------------------------------------------------------

export function addNode(
  text: string,
  fc: Flowchart,
  id: string,
  label: string,
): Change[] {
  return [appendLine(text, fc, `${id}[${formatLabel(label)}]`)];
}

export function renameNode(fc: Flowchart, id: string, label: string): Change[] {
  const node = fc.nodes.find((n) => n.id === id);
  if (!node) return [];
  const def = node.definedBy;
  if (def?.textSpan) {
    return [
      {
        from: def.textSpan.from,
        to: def.textSpan.to,
        insert: formatLabel(label, def.shape),
      },
    ];
  }
  // Bare node (`A --> B`): give its first occurrence a shape.
  const first = node.refs[0];
  return [
    {
      from: first.idSpan.to,
      to: first.idSpan.to,
      insert: `[${formatLabel(label)}]`,
    },
  ];
}

// --- Edges -------------------------------------------------------------------

export function addEdge(
  text: string,
  fc: Flowchart,
  from: string,
  to: string,
): Change[] {
  return [appendLine(text, fc, `${from} --> ${to}`)];
}

/**
 * Sets an edge label. In a group like `A & B --> C` the link is shared, so all
 * edges of that link get the label (that's how Mermaid reads it, too).
 */
export function setEdgeLabel(
  fc: Flowchart,
  edge: FlowEdge,
  label: string,
): Change[] {
  const link = edgeLink(fc, edge);
  const clean = label.trim();
  if (link.labelSpan && link.labelKind === "pipe") {
    if (!clean)
      return [{ from: link.arrowSpan.to, to: link.span.to, insert: "" }];
    return [
      {
        from: link.labelSpan.from,
        to: link.labelSpan.to,
        insert: formatEdgeLabel(clean),
      },
    ];
  }
  if (link.labelSpan && link.labelKind === "inline") {
    if (!clean)
      return [
        {
          from: link.span.from,
          to: link.span.to,
          insert: canonicalArrow(link),
        },
      ];
    return [
      {
        from: link.labelSpan.from,
        to: link.labelSpan.to,
        insert: formatEdgeLabel(clean),
      },
    ];
  }
  if (!clean) return [];
  return [
    {
      from: link.arrowSpan.to,
      to: link.arrowSpan.to,
      insert: `|${formatEdgeLabel(clean)}|`,
    },
  ];
}

// --- Deletion ----------------------------------------------------------------

/**
 * Deletes nodes (with their edges) and edges. Untouched statements stay byte
 * for byte. A touched statement is rewritten in canonical style, reusing the
 * original node tokens and arrows, and keeps every node that must survive
 * (e.g. deleting `A[Start] --> B[End]`'s edge leaves `A[Start]` and `B[End]`).
 */
export function deleteElements(
  text: string,
  fc: Flowchart,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string>,
): Change[] {
  const removeNodes = new Set(nodeIds);
  const removeEdges = new Set(edgeIds);
  const changes: Change[] = [];

  // How many statements reference each node, to know whether a node survives elsewhere.
  const stmtCount = new Map<string, number>();
  fc.statements.forEach((st) => {
    for (const id of new Set(st.groups.flat().map((r) => r.id))) {
      stmtCount.set(id, (stmtCount.get(id) ?? 0) + 1);
    }
  });
  const defOf = new Map(fc.nodes.map((n) => [n.id, n.definedBy]));

  fc.statements.forEach((st, si) => {
    const edges = fc.edges.filter((e) => e.statement === si);
    const refs = st.groups.flat();
    const touched =
      refs.some((r) => removeNodes.has(r.id)) ||
      edges.some((e) => removeEdges.has(e.id));
    if (!touched) return;

    const kept = edges.filter(
      (e) =>
        !removeEdges.has(e.id) &&
        !removeNodes.has(e.from) &&
        !removeNodes.has(e.to),
    );
    const replacement = rewriteStatement(
      text,
      st,
      kept,
      (ref) => {
        if (removeNodes.has(ref.id)) return false;
        // Keep a lone node if its definition lives here or it appears nowhere else.
        return defOf.get(ref.id) === ref || stmtCount.get(ref.id) === 1;
      },
      lineIndent(text, st.span.from),
    );
    changes.push(replaceStatement(text, st, replacement));
  });

  // Passthrough lines that only target a deleted node (`style X ...`, `click X ...`, `class X c`).
  for (const span of fc.passthrough) {
    const line = text.slice(span.from, span.to);
    const m = /^(style|click|class)[ \t]+([^\s,]+)(?=[ \t])/.exec(line);
    if (m && removeNodes.has(m[2]))
      changes.push(deleteLine(text, span.from, span.to));
  }

  return mergeOverlaps(changes);
}

/** Line deletions next to each other can overlap by one newline; merge them. */
function mergeOverlaps(changes: Change[]): Change[] {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  const out: Change[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.from < prev.to) {
      prev.to = Math.max(prev.to, c.to);
      prev.insert += c.insert;
    } else out.push({ ...c });
  }
  return out;
}

function rewriteStatement(
  text: string,
  st: Statement,
  kept: FlowEdge[],
  keepAlone: (ref: NodeRef) => boolean,
  indent: string,
): string {
  const refOf = (group: number, id: string) =>
    st.groups[group].find((r) => r.id === id)!;
  const printed = new Set<NodeRef>();
  const printedIds = new Set<string>();
  const tok = (ref: NodeRef) => {
    printedIds.add(ref.id);
    if (printed.has(ref)) return ref.id;
    printed.add(ref);
    return text.slice(ref.span.from, ref.span.to);
  };

  const lines: string[] = [];
  for (const e of kept) {
    const link = st.links[e.link];
    const a = refOf(e.link, e.from);
    const b = refOf(e.link + 1, e.to);
    lines.push(
      `${tok(a)} ${text.slice(link.span.from, link.span.to)} ${tok(b)}`,
    );
  }
  for (const ref of st.groups.flat()) {
    if (printed.has(ref) || !keepAlone(ref)) continue;
    // A bare ref of an already printed node adds nothing.
    if (!ref.shape && printedIds.has(ref.id)) continue;
    lines.push(tok(ref));
  }
  return lines.join(`\n${indent}`);
}

function replaceStatement(
  text: string,
  st: Statement,
  replacement: string,
): Change {
  if (replacement)
    return { from: st.span.from, to: st.span.to, insert: replacement };
  const lineStart = text.lastIndexOf("\n", st.span.from - 1) + 1;
  let lineEnd = text.indexOf("\n", st.span.to);
  if (lineEnd === -1) lineEnd = text.length;
  const rest = text.slice(st.span.to, lineEnd).replace(/^[ \t]*;?[ \t]*/, "");
  if (text.slice(lineStart, st.span.from).trim() === "" && rest === "") {
    return deleteLine(text, st.span.from, st.span.to);
  }
  // Shares a line with other statements (`A --> B; C --> D`): remove it with its `;`.
  const semi = /^[ \t]*;/.exec(text.slice(st.span.to));
  return {
    from: st.span.from,
    to: st.span.to + (semi ? semi[0].length : 0),
    insert: "",
  };
}

function deleteLine(text: string, from: number, to: number): Change {
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const nl = text.indexOf("\n", to);
  if (nl !== -1) return { from: lineStart, to: nl + 1, insert: "" };
  // Last line: eat the newline before it instead.
  return { from: Math.max(0, lineStart - 1), to: text.length, insert: "" };
}

/** Applies changes to a string (for tests; the app lets CodeMirror do this). */
export function applyChanges(text: string, changes: Change[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}
