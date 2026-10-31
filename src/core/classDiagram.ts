/**
 * Span-aware parser for Mermaid class diagrams (ADR-001, ADR-004).
 *
 * Like the flowchart parser it only reads the subset Mirrormaid can edit and
 * remembers where everything is in the text, so UI patches can make minimal
 * changes. Supported:
 *
 *   classDiagram
 *   direction LR
 *   class Animal                        class with optional ~Generic~, ["Label"], :::css
 *   class Animal {                      body with members and <<annotation>>
 *     <<interface>>
 *     +String name
 *     +eat(food) bool
 *   }
 *   Animal : +int age                   member line
 *   <<interface>> Animal                annotation line
 *   Animal "1" <|-- "*" Duck : label    relation with cardinalities and label
 *
 * Lines it doesn't model (notes, namespaces, styles, clicks, ...) are kept as
 * passthrough and never touched.
 */

import type { Direction, ParseError, Span } from "./flowchart";

/** Marker at one end of a relation. */
export type Marker = "triangle" | "diamond" | "diamond-open" | "arrow";

export type RelationType =
  | "inheritance"
  | "composition"
  | "aggregation"
  | "association"
  | "link"
  | "dependency"
  | "realization"
  | "dashed-link";

export interface Member {
  /** Raw member text, e.g. `+eat(food) bool` or `-int age$`. */
  text: string;
  /** Span of the member text. */
  span: Span;
  /** Span of the whole line, for deletion. */
  lineSpan: Span;
  kind: "attribute" | "method";
}

export interface ClassDecl {
  /** The `class X ...` statement, up to and including `{` if present. */
  span: Span;
  /** Position right after `{`, if the class has a body. */
  bodyOpen?: number;
  /** Span of the `}` line content, if the class has a body. */
  closeSpan?: Span;
}

export interface ClassNode {
  id: string;
  /** Display name: the `["Label"]` if given, else the id plus generics. */
  label: string;
  /** Span of the text inside `["..."]`, if the class has an explicit label. */
  labelSpan?: Span;
  annotation?: string;
  /** Span of the annotation's inner text (between `<<` and `>>`). */
  annotationSpan?: Span;
  /** Span of the line holding the annotation, for deletion. */
  annotationLine?: Span;
  members: Member[];
  decls: ClassDecl[];
  /** Every occurrence of the id in the text, for renaming. */
  idSpans: Span[];
  /** Lines that only exist for this class (declaration blocks, member and annotation lines, styles, notes). */
  ownLines: Span[];
}

export interface Relation {
  /** Stable for a given text: `<index>:<from>:<to>`. */
  id: string;
  from: string;
  to: string;
  fromMarker?: Marker;
  toMarker?: Marker;
  dashed: boolean;
  label?: string;
  fromCard?: string;
  toCard?: string;
  /** The whole relation statement. */
  span: Span;
  /** The arrow including markers and the whitespace around it. */
  arrowGap: Span;
  /** Raw label text after the `:`. */
  labelSpan?: Span;
}

export interface ClassDiagram {
  kind: "class";
  ok: boolean;
  direction: Direction;
  headerSpan?: Span;
  /** Classes, called nodes so layout code can treat all diagrams alike. */
  nodes: ClassNode[];
  /** Relations, called edges so layout code can treat all diagrams alike. */
  edges: Relation[];
  passthrough: Span[];
  errors: ParseError[];
}

const ID = String.raw`[\p{L}\p{N}_]+`;
const HEADER = /^classDiagram(?:-v2)?[ \t]*$/;
const DIRECTION = /^direction[ \t]+(TB|TD|BT|LR|RL)[ \t]*$/;
const CLASS_DECL = new RegExp(
  String.raw`^class[ \t]+(${ID})(~[^~]*~)?(?:\["([^"]*)"\])?(?::::[\w-]+)?[ \t]*(\{)?[ \t]*$`,
  "du",
);
const ANNOTATION_LINE = new RegExp(
  String.raw`^<<[ \t]*([^>]*?)[ \t]*>>[ \t]+(${ID})[ \t]*$`,
  "du",
);
const BODY_ANNOTATION = /^<<[ \t]*([^>]*?)[ \t]*>>[ \t]*$/d;
const MEMBER_LINE = new RegExp(
  String.raw`^(${ID})[ \t]*:[ \t]*(.*\S)[ \t]*$`,
  "du",
);
// `o` only counts as a marker when separated by whitespace (`A o-- B`), so
// `Foo--order` stays a link to `order`.
const RELATION = new RegExp(
  String.raw`^(${ID})(?:[ \t]+"([^"]*)")?` +
    String.raw`([ \t]*(?:<\||<|\*)?|[ \t]+o)(--|\.\.)(\|>|>|\*(?=[\s"])|o(?=[\s"]))?[ \t]*` +
    String.raw`(?:"([^"]*)"[ \t]*)?(${ID})[ \t]*(?::[ \t]*(.*?))?[ \t]*$`,
  "du",
);
/** Passthrough lines that target one class, so renames and deletes can follow it. */
const TARGETED = new RegExp(
  String.raw`^(?:style|click|link|callback|note[ \t]+for)[ \t]+(${ID})\b`,
  "du",
);
const PASSTHROUGH =
  /^(note|namespace|classDef|cssClass|style|click|link|callback|accTitle|accDescr)\b/;

export function parseClassDiagram(text: string): ClassDiagram {
  const result: ClassDiagram = {
    kind: "class",
    ok: false,
    direction: "TB",
    nodes: [],
    edges: [],
    passthrough: [],
    errors: [],
  };
  const byId = new Map<string, ClassNode>();
  const node = (id: string, idSpan: Span) => {
    let n = byId.get(id);
    if (!n) {
      n = { id, label: id, members: [], decls: [], idSpans: [], ownLines: [] };
      byId.set(id, n);
    }
    n.idSpans.push(idSpan);
    return n;
  };
  const error = (message: string, from: number, to: number) =>
    result.errors.push({ message, from, to });

  let headerSeen = false;
  /** The class whose `{ ... }` body we're in. */
  let body: { node: ClassNode; decl: ClassDecl; start: number } | undefined;
  /** Open `namespace X {` blocks. */
  let namespaces = 0;
  /** Passthrough lines aimed at one class (`style X ...`), resolved at the end. */
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

    if (line === "" || line.startsWith("%%")) {
      // empty or comment
    } else if (!headerSeen) {
      if (HEADER.test(line)) {
        headerSeen = true;
        result.headerSpan = lineSpan;
      } else {
        error("Expected `classDiagram` header", from, to);
        break;
      }
    } else if (body) {
      if (line === "}") {
        body.decl.closeSpan = lineSpan;
        body.node.ownLines.push({ from: body.start, to });
        body = undefined;
      } else {
        const a = BODY_ANNOTATION.exec(line);
        if (a) {
          body.node.annotation = a[1];
          body.node.annotationSpan = at(a.indices![1]);
          body.node.annotationLine = lineSpan;
        } else {
          body.node.members.push(member(line, lineSpan, lineSpan));
        }
      }
    } else {
      let m: RegExpExecArray | null;
      if ((m = DIRECTION.exec(line))) {
        const dir = m[1];
        result.direction = (dir === "TD" ? "TB" : dir) as Direction;
        result.passthrough.push(lineSpan);
      } else if ((m = CLASS_DECL.exec(line))) {
        const n = node(m[1], at(m.indices![1]));
        if (m[3] !== undefined) {
          n.label = m[3].replace(/#quot;/g, '"');
          n.labelSpan = at(m.indices![3]);
        } else if (m[2]) n.label = m[1] + m[2].replace(/~([^~]*)~/, "<$1>");
        const decl: ClassDecl = { span: lineSpan };
        n.decls.push(decl);
        if (m[4]) {
          decl.bodyOpen = at(m.indices![4]).to;
          body = { node: n, decl, start: from };
        } else {
          n.ownLines.push(lineSpan);
        }
      } else if ((m = ANNOTATION_LINE.exec(line))) {
        const n = node(m[2], at(m.indices![2]));
        n.annotation = m[1];
        n.annotationSpan = at(m.indices![1]);
        n.annotationLine = lineSpan;
        n.ownLines.push(lineSpan);
      } else if ((m = RELATION.exec(line))) {
        const d = m.indices!;
        const a = node(m[1], at(d[1]));
        const b = node(m[7], at(d[7]));
        const left = m[3].trim();
        const right = m[5] ?? "";
        const rel: Relation = {
          id: `${result.edges.length}:${a.id}:${b.id}`,
          from: a.id,
          to: b.id,
          fromMarker: markerOf(left),
          toMarker: markerOf(right),
          dashed: m[4] === "..",
          fromCard: m[2],
          toCard: m[6],
          span: lineSpan,
          arrowGap: arrowGap(text, at(d[3]).from, at(d[5] ?? d[4]).to),
        };
        if (m[8] !== undefined && m[8] !== "") {
          rel.label = m[8];
          rel.labelSpan = at(d[8]);
        }
        result.edges.push(rel);
      } else if ((m = MEMBER_LINE.exec(line))) {
        const n = node(m[1], at(m.indices![1]));
        n.members.push(member(m[2], at(m.indices![2]), lineSpan));
        n.ownLines.push(lineSpan);
      } else if (/^namespace\b.*\{$/.test(line)) {
        namespaces++;
        result.passthrough.push(lineSpan);
      } else if (line === "}" && namespaces > 0) {
        namespaces--;
        result.passthrough.push(lineSpan);
      } else if (PASSTHROUGH.test(line)) {
        result.passthrough.push(lineSpan);
        const t = TARGETED.exec(line);
        if (t)
          targeted.push({
            id: t[1],
            idSpan: at(t.indices![1]),
            line: lineSpan,
          });
      } else if (/^class\b/.test(line) && line.includes("{")) {
        error(
          "Put the members of a class on their own lines after `{`",
          from,
          to,
        );
      } else {
        error("Unrecognized line in class diagram", from, to);
      }
    }

    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }

  if (body)
    error(
      `Missing \`}\` to close class \`${body.node.id}\``,
      body.decl.span.from,
      body.decl.span.to,
    );
  if (!headerSeen && result.errors.length === 0)
    error("Empty diagram: add a `classDiagram` header", 0, 0);

  for (const t of targeted) {
    const target = byId.get(t.id);
    if (!target) continue;
    target.idSpans.push(t.idSpan);
    target.ownLines.push(t.line);
  }
  result.nodes = [...byId.values()];
  result.ok = result.errors.length === 0;
  return result;
}

function member(text: string, span: Span, lineSpan: Span): Member {
  return {
    text,
    span,
    lineSpan,
    kind: text.includes("(") ? "method" : "attribute",
  };
}

function markerOf(s: string): Marker | undefined {
  switch (s) {
    case "<|":
    case "|>":
      return "triangle";
    case "*":
      return "diamond";
    case "o":
      return "diamond-open";
    case "<":
    case ">":
      return "arrow";
  }
  return undefined;
}

/** Widens the arrow span over the whitespace on both sides. */
function arrowGap(text: string, from: number, to: number): Span {
  while (from > 0 && /[ \t]/.test(text[from - 1])) from--;
  while (to < text.length && /[ \t]/.test(text[to])) to++;
  return { from, to };
}

// --- Relation types ------------------------------------------------------------

const TYPE_STYLE: Record<RelationType, { marker?: Marker; dashed: boolean }> = {
  inheritance: { marker: "triangle", dashed: false },
  composition: { marker: "diamond", dashed: false },
  aggregation: { marker: "diamond-open", dashed: false },
  association: { marker: "arrow", dashed: false },
  link: { dashed: false },
  dependency: { marker: "arrow", dashed: true },
  realization: { marker: "triangle", dashed: true },
  "dashed-link": { dashed: true },
};

/** The type of a relation, or undefined for two-way relations like `<|--|>`. */
export function relationType(rel: Relation): RelationType | undefined {
  if (rel.fromMarker && rel.toMarker) return undefined;
  const marker = rel.fromMarker ?? rel.toMarker;
  return (Object.keys(TYPE_STYLE) as RelationType[]).find(
    (t) =>
      TYPE_STYLE[t].marker === marker && TYPE_STYLE[t].dashed === rel.dashed,
  );
}

/** Mermaid arrow for a type, with the marker on the left (`<|--`) or right (`--|>`). */
export function relationArrow(type: RelationType, side: "left" | "right") {
  const { marker, dashed } = TYPE_STYLE[type];
  const line = dashed ? ".." : "--";
  if (!marker) return line;
  const l = { triangle: "<|", diamond: "*", "diamond-open": "o", arrow: "<" };
  const r = { triangle: "|>", diamond: "*", "diamond-open": "o", arrow: ">" };
  return side === "left" ? l[marker] + line : line + r[marker];
}

export const isClassId = (s: string) => new RegExp(`^${ID}$`, "u").test(s);

/**
 * How a member is shown: generics `~T~` become `<T>`, and a trailing `$`
 * (static) or `*` (abstract) becomes styling instead of text.
 */
export function displayMember(text: string): {
  text: string;
  isStatic: boolean;
  isAbstract: boolean;
} {
  let t = text.trim();
  let classifier = "";
  // Mermaid allows the classifier right after `()` or at the very end.
  t = t.replace(/\)([$*])/, (_, c: string) => ((classifier = c), ")"));
  const end = /([$*])$/.exec(t);
  if (end) {
    classifier = end[1];
    t = t.slice(0, -1).trimEnd();
  }
  // `~` opens a generic between two word chars (`List~int`) and closes otherwise,
  // so nested ones like `List~List~int~~` work too.
  t = t.replace(/~/g, (_, i: number) =>
    /\w/.test(t[i - 1] ?? "") && /\w/.test(t[i + 1] ?? "") ? "<" : ">",
  );
  const isStatic = classifier === "$";
  const isAbstract = classifier === "*";
  return { text: t, isStatic, isAbstract };
}
