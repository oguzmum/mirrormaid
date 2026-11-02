/**
 * Span-aware parser for Mermaid state diagrams (ADR-001, ADR-004).
 *
 * Like the other parsers it only reads the subset Mirrormaid can edit and
 * remembers where everything is in the text, so UI patches can make minimal
 * changes. Supported:
 *
 *   stateDiagram-v2                     (or `stateDiagram`)
 *   direction LR
 *   Idle                                bare state declaration
 *   state Idle                          state declaration
 *   state "Waiting for input" as Idle   state with a description
 *   Idle : Waiting for input            description line
 *   state check <<choice>>              special states: choice, fork, join
 *   [*] --> Idle                        start (on the left) / end (on the right)
 *   Idle --> Busy : start job           transition with optional label
 *   note right of Idle : text           notes (single and multi-line), kept as is
 *
 * Composite states (`state X { ... }`) and concurrency (`--`) are not supported
 * yet; they make the result carry an error, so the canvas goes read-only.
 */

import type { Direction, ParseError, Span } from "./flowchart";

export type StateKind = "state" | "start" | "end" | "choice" | "fork" | "join";

/** Node IDs for `[*]`. Brackets can't appear in real state IDs, so they never clash. */
export const START_ID = "[*]start";
export const END_ID = "[*]end";

export interface Description {
  /** Span of the description text. */
  span: Span;
  /** The whole line, for deletion (only for `Id : text` lines). */
  lineSpan?: Span;
}

export interface StateNode {
  id: string;
  kind: StateKind;
  /** Display text: the descriptions joined by newlines, else the id. */
  label: string;
  /** From `state "x" as Id` and `Id : x`, in source order. */
  descriptions: Description[];
  /** Span of `choice` / `fork` / `join` inside `<<...>>`. */
  typeSpan?: Span;
  /** The `state Id <<choice>>` line. */
  typeLine?: Span;
  /** Every occurrence of the id in the text (for `[*]`: every `[*]` token). */
  idSpans: Span[];
  /** Lines that only exist for this state (declarations, descriptions, notes, styles). */
  ownLines: Span[];
}

export interface Transition {
  /** Stable for a given text: `<index>:<from>:<to>`. */
  id: string;
  from: string;
  to: string;
  label?: string;
  /** Raw label text after the `:`. */
  labelSpan?: Span;
  /** The whole transition statement. */
  span: Span;
}

export interface StateDiagram {
  kind: "state";
  ok: boolean;
  direction: Direction;
  headerSpan?: Span;
  /** States, called nodes so layout code can treat all diagrams alike. */
  nodes: StateNode[];
  /** Transitions, called edges so layout code can treat all diagrams alike. */
  edges: Transition[];
  passthrough: Span[];
  errors: ParseError[];
}

const ID = String.raw`[\p{L}\p{N}_]+`;
const REF = String.raw`(\[\*\]|${ID})(?::::[\w-]+)?`;
const HEADER = /^stateDiagram(?:-v2)?[ \t]*$/;
const DIRECTION = /^direction[ \t]+(TB|TD|BT|LR|RL)[ \t]*$/;
const TRANSITION = new RegExp(
  String.raw`^${REF}[ \t]*-->[ \t]*${REF}[ \t]*(?::[ \t]*(.*?))?[ \t]*$`,
  "du",
);
const STATE_AS = new RegExp(
  String.raw`^state[ \t]+"([^"]*)"[ \t]+as[ \t]+(${ID})(?::::[\w-]+)?[ \t]*$`,
  "du",
);
const STATE_TYPE = new RegExp(
  String.raw`^state[ \t]+(${ID})[ \t]*<<[ \t]*(choice|fork|join)[ \t]*>>[ \t]*$`,
  "du",
);
const STATE_DECL = new RegExp(
  String.raw`^state[ \t]+(${ID})(?::::[\w-]+)?[ \t]*$`,
  "du",
);
const BARE = new RegExp(String.raw`^(${ID})(?::::[\w-]+)?[ \t]*$`, "du");
const DESCRIPTION = new RegExp(
  String.raw`^(${ID})[ \t]*:[ \t]*(.*\S)[ \t]*$`,
  "du",
);
const NOTE_LINE = new RegExp(
  String.raw`^note[ \t]+(?:left|right)[ \t]+of[ \t]+(${ID})[ \t]*:`,
  "du",
);
const NOTE_BLOCK = new RegExp(
  String.raw`^note[ \t]+(?:left|right)[ \t]+of[ \t]+(${ID})[ \t]*$`,
  "du",
);
const TARGETED = new RegExp(
  String.raw`^(?:class|style|click)[ \t]+(${ID})(?=[ \t])`,
  "du",
);
const PASSTHROUGH =
  /^(classDef|class|style|click|hide|scale|accTitle|accDescr)\b/;

export function parseStateDiagram(text: string): StateDiagram {
  const result: StateDiagram = {
    kind: "state",
    ok: false,
    direction: "TB",
    nodes: [],
    edges: [],
    passthrough: [],
    errors: [],
  };
  const byId = new Map<string, StateNode>();
  const node = (id: string, idSpan: Span, kind: StateKind = "state") => {
    let n = byId.get(id);
    if (!n) {
      n = {
        id,
        kind,
        label: id,
        descriptions: [],
        idSpans: [],
        ownLines: [],
      };
      byId.set(id, n);
    }
    n.idSpans.push(idSpan);
    return n;
  };
  const error = (message: string, from: number, to: number) =>
    result.errors.push({ message, from, to });

  let headerSeen = false;
  /** Inside a multi-line `note ... end note` block. */
  let note: { id: string; idSpan: Span; start: number } | undefined;
  /** Inside a multi-line `accDescr { ... }` block. */
  let accDescr = false;
  /** Passthrough lines aimed at one state (`style X ...`), resolved at the end. */
  const targeted: { id: string; idSpan: Span; line: Span }[] = [];

  let pos = 0;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const raw = text.slice(pos, lineEnd);
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const from = pos + indent;
    const to = from + line.length;
    const at = (d: [number, number] | undefined): Span => ({
      from: from + d![0],
      to: from + d![1],
    });
    const lineSpan = { from, to };

    if (note) {
      if (/^end[ \t]+note$/.test(line)) {
        const block = { from: note.start, to };
        result.passthrough.push(block);
        targeted.push({ id: note.id, idSpan: note.idSpan, line: block });
        note = undefined;
      }
    } else if (accDescr) {
      result.passthrough.push(lineSpan);
      if (line.includes("}")) accDescr = false;
    } else if (line === "" || line.startsWith("%%")) {
      // empty or comment
    } else if (!headerSeen) {
      if (HEADER.test(line)) {
        headerSeen = true;
        result.headerSpan = lineSpan;
      } else {
        error("Expected `stateDiagram-v2` header", from, to);
        break;
      }
    } else {
      let m: RegExpExecArray | null;
      if ((m = DIRECTION.exec(line))) {
        const dir = m[1];
        result.direction = (dir === "TD" ? "TB" : dir) as Direction;
        result.passthrough.push(lineSpan);
      } else if ((m = TRANSITION.exec(line))) {
        const d = m.indices!;
        const ref = (i: number, side: "from" | "to") =>
          m![i] === "[*]"
            ? node(
                side === "from" ? START_ID : END_ID,
                at(d[i]),
                side === "from" ? "start" : "end",
              )
            : node(m![i], at(d[i]));
        const a = ref(1, "from");
        const b = ref(2, "to");
        const t: Transition = {
          id: `${result.edges.length}:${a.id}:${b.id}`,
          from: a.id,
          to: b.id,
          span: lineSpan,
        };
        if (m[3] !== undefined && m[3] !== "") {
          t.label = m[3];
          t.labelSpan = at(d[3]);
        }
        result.edges.push(t);
      } else if ((m = STATE_AS.exec(line))) {
        const n = node(m[2], at(m.indices![2]));
        n.descriptions.push({ span: at(m.indices![1]) });
        n.ownLines.push(lineSpan);
      } else if ((m = STATE_TYPE.exec(line))) {
        const n = node(m[1], at(m.indices![1]));
        n.kind = m[2] as StateKind;
        n.typeSpan = at(m.indices![2]);
        n.typeLine = lineSpan;
        n.ownLines.push(lineSpan);
      } else if ((m = STATE_DECL.exec(line))) {
        node(m[1], at(m.indices![1])).ownLines.push(lineSpan);
      } else if (/^state\b.*\{[ \t]*$/.test(line)) {
        error(
          "Composite states (`state X { ... }`) are not supported yet",
          from,
          to,
        );
      } else if (/^state\b/.test(line)) {
        error("Unrecognized state declaration", from, to);
      } else if ((m = NOTE_LINE.exec(line))) {
        result.passthrough.push(lineSpan);
        targeted.push({ id: m[1], idSpan: at(m.indices![1]), line: lineSpan });
      } else if ((m = NOTE_BLOCK.exec(line))) {
        note = { id: m[1], idSpan: at(m.indices![1]), start: from };
      } else if (/^accDescr[ \t]*\{/.test(line)) {
        result.passthrough.push(lineSpan);
        accDescr = !line.includes("}");
      } else if (PASSTHROUGH.test(line)) {
        result.passthrough.push(lineSpan);
        const t = TARGETED.exec(line);
        if (t)
          targeted.push({
            id: t[1],
            idSpan: at(t.indices![1]),
            line: lineSpan,
          });
      } else if ((m = DESCRIPTION.exec(line))) {
        const n = node(m[1], at(m.indices![1]));
        n.descriptions.push({ span: at(m.indices![2]), lineSpan });
        n.ownLines.push(lineSpan);
      } else if ((m = BARE.exec(line))) {
        node(m[1], at(m.indices![1])).ownLines.push(lineSpan);
      } else if (line === "--") {
        error("Concurrent regions (`--`) are not supported yet", from, to);
      } else {
        error("Unrecognized line in state diagram", from, to);
      }
    }

    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }

  if (note) error("Missing `end note`", note.start, note.start);
  if (!headerSeen && result.errors.length === 0)
    error("Empty diagram: add a `stateDiagram-v2` header", 0, 0);

  for (const t of targeted) {
    const target = byId.get(t.id);
    if (!target) continue;
    target.idSpans.push(t.idSpan);
    target.ownLines.push(t.line);
  }
  for (const n of byId.values()) {
    if (n.descriptions.length)
      n.label = n.descriptions
        .map((d) => text.slice(d.span.from, d.span.to).replace(/#quot;/g, '"'))
        .join("\n");
  }
  result.nodes = [...byId.values()];
  result.ok = result.errors.length === 0;
  return result;
}

export const isStateId = (s: string) => new RegExp(`^${ID}$`, "u").test(s);

/** Start and end are drawn as dots and can't be renamed or retyped. */
export const isPseudo = (kind: StateKind) => kind === "start" || kind === "end";
