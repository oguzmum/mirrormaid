/**
 * Patch rules for state diagrams: every UI action becomes a small set of text
 * changes (ADR-001), like `patches.ts` does for flowcharts.
 *
 * Canonical style for inserted code: a bare `    Name` line for new states,
 * `    Name : description` for descriptions, `    state Name <<choice>>` for
 * special states and `    A --> B` for transitions.
 */

import {
  END_ID,
  START_ID,
  isPseudo,
  isStateId,
  type StateDiagram,
  type StateKind,
  type StateNode,
  type Transition,
} from "./stateDiagram";
import type { Span } from "./flowchart";
import { deleteLine, lineIndent, mergeOverlaps, type Change } from "./patches";

const UNIT = "    ";

/** Indentation for new top-level lines: the one of the first line after the header. */
function topIndent(text: string, d: StateDiagram): string {
  if (!d.headerSpan) return UNIT;
  const rest = text.slice(d.headerSpan.to);
  const m = /\n([ \t]*)(?=\S)(?!%%)/.exec(rest);
  return m ? m[1] : UNIT;
}

function appendLines(text: string, d: StateDiagram, lines: string[]): Change {
  const end = text.replace(/\s+$/, "").length;
  const indent = topIndent(text, d);
  return {
    from: end,
    to: text.length,
    insert: lines.map((l) => `\n${indent}${l}`).join("") + "\n",
  };
}

const lineStart = (text: string, at: number) =>
  text.lastIndexOf("\n", at - 1) + 1;

const lineEnd = (text: string, at: number) => {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl;
};

/** Inserts a line right before the line holding `at`, with that line's indentation. */
function insertLineBefore(text: string, at: number, line: string): Change {
  const start = lineStart(text, at);
  return { from: start, to: start, insert: `${lineIndent(text, at)}${line}\n` };
}

/** Inserts a line right after the line holding `at`, with that line's indentation. */
function insertLineAfter(text: string, at: number, line: string): Change {
  const end = lineEnd(text, at);
  return { from: end, to: end, insert: `\n${lineIndent(text, at)}${line}` };
}

function find(d: StateDiagram, id: string): StateNode | undefined {
  return d.nodes.find((n) => n.id === id);
}

/** How a node id is written in a transition. */
const ref = (id: string) => (id === START_ID || id === END_ID ? "[*]" : id);

export function nextStateId(d: StateDiagram): string {
  const taken = new Set(d.nodes.map((n) => n.id));
  if (!taken.has("NewState")) return "NewState";
  for (let i = 2; ; i++) if (!taken.has(`NewState${i}`)) return `NewState${i}`;
}

// --- States --------------------------------------------------------------------

export function addState(text: string, d: StateDiagram, id: string): Change[] {
  return [appendLines(text, d, [id])];
}

/** The text a user edits when renaming: the description if any, else the id. */
export function editableStateName(node: StateNode): string {
  return node.descriptions.length ? node.label : node.id;
}

export interface RenameResult {
  changes: Change[];
  /** Set when the id changed, so positions and routes can follow. */
  newId?: string;
  error?: string;
}

const formatDescription = (s: string) =>
  s.replace(/\s+/g, " ").trim().replace(/"/g, "#quot;");

/**
 * Renames a state. A state with a description gets a new description (extra
 * description lines are merged into the first). Otherwise the id is renamed at
 * every occurrence, or, if the new name isn't a valid id (e.g. it has spaces),
 * the state gets a description line instead.
 */
export function renameState(
  text: string,
  d: StateDiagram,
  id: string,
  name: string,
): RenameResult {
  const node = find(d, id);
  const clean = name.trim();
  if (
    !node ||
    isPseudo(node.kind) ||
    !clean ||
    clean === editableStateName(node)
  )
    return { changes: [] };

  if (node.descriptions.length) {
    const [first, ...rest] = node.descriptions;
    return {
      changes: mergeOverlaps([
        {
          from: first.span.from,
          to: first.span.to,
          insert: formatDescription(clean),
        },
        ...rest
          .filter((r) => r.lineSpan)
          .map((r) => deleteLine(text, r.lineSpan!.from, r.lineSpan!.to)),
      ]),
    };
  }
  if (!isStateId(clean)) {
    const first = node.idSpans.reduce((a, b) => (b.from < a.from ? b : a));
    return {
      changes: [
        insertLineAfter(
          text,
          first.from,
          `${id} : ${formatDescription(clean)}`,
        ),
      ],
    };
  }
  if (find(d, clean))
    return { changes: [], error: `A state named ${clean} already exists` };
  return {
    changes: node.idSpans.map((s) => ({
      from: s.from,
      to: s.to,
      insert: clean,
    })),
    newId: clean,
  };
}

/**
 * Turns a state into a choice, fork or join, or back into a normal state.
 * The `state X <<choice>>` line goes before the first mention of X, because
 * Mermaid only applies the type when it sees it first.
 */
export function setStateKind(
  text: string,
  d: StateDiagram,
  id: string,
  kind: Exclude<StateKind, "start" | "end">,
): Change[] {
  const node = find(d, id);
  if (!node || isPseudo(node.kind) || node.kind === kind) return [];
  if (node.typeSpan) {
    if (kind !== "state")
      return [{ from: node.typeSpan.from, to: node.typeSpan.to, insert: kind }];
    const line = node.typeLine!;
    // Deleting the only line that mentions the state would delete the state, too.
    const onlyMention = node.idSpans.every(
      (s) => s.from >= line.from && s.to <= line.to,
    );
    if (onlyMention) return [{ from: line.from, to: line.to, insert: id }];
    return [deleteLine(text, line.from, line.to)];
  }
  if (kind === "state") return [];
  const first = node.idSpans.reduce((a, b) => (b.from < a.from ? b : a));
  return [insertLineBefore(text, first.from, `state ${id} <<${kind}>>`)];
}

// --- Transitions ---------------------------------------------------------------

export interface TransitionResult {
  changes: Change[];
  error?: string;
}

/**
 * Adds a transition. Start can only be a source and end only a target, so a
 * connection drawn the "wrong" way round is flipped.
 */
export function addTransition(
  text: string,
  d: StateDiagram,
  from: string,
  to: string,
): TransitionResult {
  if (to === START_ID || from === END_ID) [from, to] = [to, from];
  if (
    to === START_ID ||
    from === END_ID ||
    (from === START_ID && to === END_ID)
  )
    return {
      changes: [],
      error: "Start can only have outgoing and end only incoming transitions",
    };
  return { changes: [appendLines(text, d, [`${ref(from)} --> ${ref(to)}`])] };
}

/** `[*] --> X` or `X --> [*]`, appended after the last line. */
export function connectPseudo(
  text: string,
  d: StateDiagram,
  id: string,
  which: "start" | "end",
): Change[] {
  return [
    appendLines(text, d, [
      which === "start" ? `[*] --> ${id}` : `${id} --> [*]`,
    ]),
  ];
}

export function setTransitionLabel(
  text: string,
  t: Transition,
  label: string,
): Change[] {
  const clean = label.replace(/\s+/g, " ").trim();
  if (t.labelSpan) {
    if (clean)
      return [{ from: t.labelSpan.from, to: t.labelSpan.to, insert: clean }];
    let from = text.lastIndexOf(":", t.labelSpan.from);
    while (from > t.span.from && /[ \t]/.test(text[from - 1])) from--;
    return [{ from, to: t.labelSpan.to, insert: "" }];
  }
  if (!clean) return [];
  const dangling = text.slice(t.span.from, t.span.to).endsWith(":");
  return [
    {
      from: t.span.to,
      to: t.span.to,
      insert: dangling ? ` ${clean}` : ` : ${clean}`,
    },
  ];
}

// --- Deletion ------------------------------------------------------------------

/**
 * Deletes states (with everything that belongs to them and their transitions)
 * and transitions. A state that is only mentioned in a deleted transition is
 * kept as a bare `X` line in its place, so deleting a transition never deletes
 * a state. Start and end disappear with their last transition, as in Mermaid.
 */
export function deleteStateElements(
  text: string,
  d: StateDiagram,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string>,
): Change[] {
  const removeNodes = new Set(nodeIds);
  const removeEdges = new Set(edgeIds);
  const gone: Span[] = [];
  for (const n of d.nodes) if (removeNodes.has(n.id)) gone.push(...n.ownLines);
  const ts = d.edges.filter(
    (t) =>
      removeEdges.has(t.id) || removeNodes.has(t.from) || removeNodes.has(t.to),
  );
  gone.push(...ts.map((t) => t.span));

  const inGone = (s: Span) =>
    gone.some((g) => s.from >= g.from && s.to <= g.to);
  const keepers = new Map<Transition, string[]>();
  for (const n of d.nodes) {
    if (removeNodes.has(n.id) || isPseudo(n.kind) || !n.idSpans.every(inGone))
      continue;
    const t = ts.find((t) => t.from === n.id || t.to === n.id);
    if (t) keepers.set(t, [...(keepers.get(t) ?? []), n.id]);
  }

  const changes: Change[] = [];
  const seen = new Set<number>();
  for (const s of gone) {
    if (seen.has(s.from)) continue;
    seen.add(s.from);
    const t = ts.find((t) => t.span === s);
    const keep = t && keepers.get(t);
    if (keep) {
      const indent = lineIndent(text, s.from);
      changes.push({
        from: s.from,
        to: s.to,
        insert: keep.join(`\n${indent}`),
      });
    } else changes.push(deleteLine(text, s.from, s.to));
  }
  return mergeOverlaps(changes);
}
