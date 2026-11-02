/**
 * Span-aware parser for Mermaid flowcharts (ADR-001, hybrid source of truth).
 *
 * The text stays the source of truth. This parser builds a read-only model and
 * remembers where every node token, link and label sits in the source, so UI
 * edits can be turned into small text patches.
 *
 * Lines it does not understand on purpose (classDef, style, subgraph, ...) are
 * skipped and left untouched. Everything else must parse, otherwise the result
 * carries errors and the UI goes read-only.
 */

export interface Span {
  from: number;
  to: number;
}

export type Direction = "TB" | "BT" | "LR" | "RL";

export type Shape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "double-circle"
  | "asymmetric"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "parallelogram-alt"
  | "trapezoid"
  | "trapezoid-alt";

/** One occurrence of a node in the source, e.g. `A`, `A[Start]` or `A:::cls`. */
export interface NodeRef {
  id: string;
  idSpan: Span;
  /** The whole token including shape and `:::class`. */
  span: Span;
  shape?: Shape;
  label?: string;
  /** Raw text between the shape's brackets (may include quotes). */
  textSpan?: Span;
}

export type LinkStyle = "solid" | "dotted" | "thick" | "invisible";
export type LinkHead = "arrow" | "cross" | "circle" | "none";

export interface Link {
  /** Whole link including its label, e.g. `-->|yes|` or `-- yes -->`. */
  span: Span;
  /** The arrow part only, e.g. `-->`. For inline labels this is the closing part. */
  arrowSpan: Span;
  style: LinkStyle;
  head: LinkHead;
  /** `<-->` style links. */
  tailArrow: boolean;
  label?: string;
  /** Raw label text (may include quotes). */
  labelSpan?: Span;
  labelKind?: "pipe" | "inline";
}

/** `A & B --> C --> D` is one statement with groups [[A,B],[C],[D]] and two links. */
export interface Statement {
  span: Span;
  groups: NodeRef[][];
  links: Link[];
}

export interface FlowNode {
  id: string;
  label: string;
  shape: Shape;
  /** The ref whose shape/label wins (the last one with a shape, like Mermaid). */
  definedBy?: NodeRef;
  refs: NodeRef[];
}

export interface FlowEdge {
  /** Stable for a given text: `<statement>:<link>:<from>:<to>`. */
  id: string;
  from: string;
  to: string;
  statement: number;
  link: number;
}

export interface ParseError {
  message: string;
  from: number;
  to: number;
}

export interface Flowchart {
  kind: "flowchart";
  ok: boolean;
  direction: Direction;
  headerSpan?: Span;
  nodes: FlowNode[];
  edges: FlowEdge[];
  statements: Statement[];
  /** Lines skipped on purpose (classDef, style, subgraph, ...). */
  passthrough: Span[];
  errors: ParseError[];
}

const PASSTHROUGH =
  /^(classDef|class|style|linkStyle|click|subgraph|end|direction|accTitle|accDescr)\b/;
const HEADER = /^(flowchart|graph)(?:[ \t]+(TB|TD|BT|LR|RL))?[ \t]*;?[ \t]*$/;

/** Shape openers, longest first so `((` wins over `(`. */
const SHAPES: { open: string; close: string[]; shape: Shape[] }[] = [
  { open: "(((", close: [")))"], shape: ["double-circle"] },
  { open: "([", close: ["])"], shape: ["stadium"] },
  { open: "[[", close: ["]]"], shape: ["subroutine"] },
  { open: "[(", close: [")]"], shape: ["cylinder"] },
  { open: "((", close: ["))"], shape: ["circle"] },
  { open: "{{", close: ["}}"], shape: ["hexagon"] },
  { open: "[/", close: ["/]", "\\]"], shape: ["parallelogram", "trapezoid"] },
  {
    open: "[\\",
    close: ["\\]", "/]"],
    shape: ["parallelogram-alt", "trapezoid-alt"],
  },
  { open: ">", close: ["]"], shape: ["asymmetric"] },
  { open: "(", close: [")"], shape: ["round"] },
  { open: "[", close: ["]"], shape: ["rect"] },
  { open: "{", close: ["}"], shape: ["diamond"] },
];

export const SHAPE_DELIMS: Record<Shape, [string, string]> = {
  rect: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  subroutine: ["[[", "]]"],
  cylinder: ["[(", ")]"],
  circle: ["((", "))"],
  "double-circle": ["(((", ")))"],
  asymmetric: [">", "]"],
  diamond: ["{", "}"],
  hexagon: ["{{", "}}"],
  parallelogram: ["[/", "/]"],
  "parallelogram-alt": ["[\\", "\\]"],
  trapezoid: ["[/", "\\]"],
  "trapezoid-alt": ["[\\", "/]"],
};

const ID_CHAR = /[\p{L}\p{N}_]/u;

class SyntaxError_ extends Error {
  constructor(
    message: string,
    public from: number,
    public to: number,
  ) {
    super(message);
  }
}

export function unquote(raw: string): string {
  const t = raw.trim();
  const inner =
    t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  return inner.replace(/#quot;/g, '"').replace(/#124;/g, "|");
}

export function parseFlowchart(text: string): Flowchart {
  const result: Flowchart = {
    kind: "flowchart",
    ok: false,
    direction: "TB",
    nodes: [],
    edges: [],
    statements: [],
    passthrough: [],
    errors: [],
  };

  let pos = 0;
  let headerSeen = false;
  while (pos <= text.length) {
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd === -1) lineEnd = text.length;
    const raw = text.slice(pos, lineEnd);
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const lineFrom = pos + indent;
    const lineTo = lineFrom + line.length;

    if (line === "" || line.startsWith("%%")) {
      // empty or comment
    } else if (!headerSeen) {
      const m = HEADER.exec(line);
      if (m) {
        headerSeen = true;
        result.headerSpan = { from: lineFrom, to: lineTo };
        const dir = m[2] ?? "TB";
        result.direction = (dir === "TD" ? "TB" : dir) as Direction;
      } else {
        result.errors.push({
          message:
            "Expected a `flowchart`, `graph`, `classDiagram` or `stateDiagram-v2` header (other diagram types are not supported yet)",
          from: lineFrom,
          to: lineTo,
        });
        break;
      }
    } else if (PASSTHROUGH.test(line)) {
      result.passthrough.push({ from: lineFrom, to: lineTo });
    } else {
      parseLine(text, lineFrom, lineTo, result);
    }

    if (lineEnd === text.length) break;
    pos = lineEnd + 1;
  }

  if (!headerSeen && result.errors.length === 0) {
    result.errors.push({
      message: "Empty diagram: add a `flowchart LR` header",
      from: 0,
      to: 0,
    });
  }

  buildModel(result);
  result.ok = result.errors.length === 0;
  return result;
}

function parseLine(text: string, from: number, to: number, result: Flowchart) {
  const p = new Cursor(text, from, to);
  try {
    for (;;) {
      p.skipWs();
      if (p.done()) return;
      result.statements.push(parseStatement(p));
      p.skipWs();
      if (p.done()) return;
      if (p.peek() === ";") {
        p.pos++;
        continue;
      }
      throw new SyntaxError_(`Unexpected \`${p.peek()}\``, p.pos, p.pos + 1);
    }
  } catch (e) {
    if (e instanceof SyntaxError_) {
      result.errors.push({
        message: e.message,
        from: e.from,
        to: Math.max(e.to, e.from),
      });
    } else throw e;
  }
}

class Cursor {
  constructor(
    public text: string,
    public pos: number,
    public end: number,
  ) {}
  done() {
    return this.pos >= this.end;
  }
  peek(n = 0) {
    return this.pos + n < this.end ? this.text[this.pos + n] : "";
  }
  startsWith(s: string) {
    return this.pos + s.length <= this.end && this.text.startsWith(s, this.pos);
  }
  skipWs() {
    while (!this.done() && (this.peek() === " " || this.peek() === "\t"))
      this.pos++;
  }
  rest() {
    return this.text.slice(this.pos, this.end);
  }
}

function parseStatement(p: Cursor): Statement {
  const start = p.pos;
  const groups: NodeRef[][] = [parseGroup(p)];
  const links: Link[] = [];
  for (;;) {
    const save = p.pos;
    p.skipWs();
    if (p.done() || p.peek() === ";") {
      p.pos = save;
      break;
    }
    const link = parseLink(p);
    if (!link)
      throw new SyntaxError_(
        "Expected a link like `-->` or end of line",
        p.pos,
        p.end,
      );
    links.push(link);
    p.skipWs();
    if (p.done())
      throw new SyntaxError_(
        "Link has no target node",
        link.span.from,
        link.span.to,
      );
    groups.push(parseGroup(p));
  }
  return { span: { from: start, to: p.pos }, groups, links };
}

function parseGroup(p: Cursor): NodeRef[] {
  const refs = [parseNode(p)];
  for (;;) {
    const save = p.pos;
    p.skipWs();
    if (p.peek() === "&") {
      p.pos++;
      p.skipWs();
      refs.push(parseNode(p));
    } else {
      p.pos = save;
      return refs;
    }
  }
}

function parseNode(p: Cursor): NodeRef {
  const start = p.pos;
  while (!p.done()) {
    const c = p.peek();
    if (ID_CHAR.test(c)) p.pos++;
    else if (c === "-" && ID_CHAR.test(p.peek(1)) && p.pos > start) p.pos++;
    else break;
  }
  if (p.pos === start) {
    throw new SyntaxError_(
      p.done()
        ? "Expected a node"
        : `Expected a node ID, found \`${p.peek()}\``,
      p.pos,
      p.pos + 1,
    );
  }
  const ref: NodeRef = {
    id: p.text.slice(start, p.pos),
    idSpan: { from: start, to: p.pos },
    span: { from: start, to: p.pos },
  };
  if (p.peek() === "@") {
    throw new SyntaxError_(
      "The `@{ ... }` node syntax is not supported yet",
      p.pos,
      p.end,
    );
  }

  for (const s of SHAPES) {
    if (!p.startsWith(s.open)) continue;
    const openEnd = p.pos + s.open.length;
    p.pos = openEnd;
    let textEnd = -1;
    let closer = "";
    let shape: Shape = s.shape[0];
    if (p.peek() === '"') {
      const q = p.text.indexOf('"', p.pos + 1);
      if (q === -1 || q >= p.end)
        throw new SyntaxError_("Unclosed quote", p.pos, p.end);
      p.pos = q + 1;
      s.close.forEach((c, i) => {
        if (textEnd === -1 && p.startsWith(c)) {
          textEnd = p.pos;
          closer = c;
          shape = s.shape[i];
        }
      });
    } else {
      let best = -1;
      s.close.forEach((c, i) => {
        const at = p.text.indexOf(c, p.pos);
        if (at !== -1 && at + c.length <= p.end && (best === -1 || at < best)) {
          best = at;
          closer = c;
          shape = s.shape[i];
        }
      });
      textEnd = best;
    }
    if (textEnd === -1) {
      throw new SyntaxError_(
        `Missing \`${s.close[0]}\` to close \`${s.open}\``,
        start,
        p.end,
      );
    }
    ref.textSpan = { from: openEnd, to: textEnd };
    ref.label = unquote(p.text.slice(openEnd, textEnd));
    ref.shape = shape;
    p.pos = textEnd + closer.length;
    break;
  }

  // Optional `:::className`
  if (p.startsWith(":::")) {
    p.pos += 3;
    while (!p.done() && /[\w-]/.test(p.peek())) p.pos++;
  }
  ref.span.to = p.pos;
  return ref;
}

/** Matches a complete arrow at the cursor. */
const ARROW = /^(<?)(-{2,}|={2,}|-\.+-|~{3,})([>xo]?)/;

function parseLink(p: Cursor): Link | undefined {
  const start = p.pos;
  const rest = p.rest();

  // Inline label form: `-- text -->`, `== text ==>`, `-. text .->`
  const inlineOpen = /^(<?)(--|==|-\.)(?=[ \t])/.exec(rest);
  if (inlineOpen) {
    const kind = inlineOpen[2];
    const closeRe =
      kind === "--"
        ? /[ \t](-{2,}[>xo]?)/
        : kind === "=="
          ? /[ \t](={2,}[>xo]?)/
          : /[ \t](\.-+[>xo]?)/;
    const afterOpen = start + inlineOpen[0].length;
    const m = closeRe.exec(p.text.slice(afterOpen, p.end));
    // `-- -->`? Treat the open part as a full arrow only if a closing part exists.
    if (m) {
      const closeFrom = afterOpen + m.index + 1;
      const closeTo = closeFrom + m[1].length;
      const rawFrom = afterOpen;
      const rawTo = afterOpen + m.index;
      const raw = p.text.slice(rawFrom, rawTo);
      const trimStart = raw.length - raw.trimStart().length;
      const labelSpan = {
        from: rawFrom + trimStart,
        to: rawFrom + raw.trimEnd().length,
      };
      const headCh = m[1].slice(-1);
      p.pos = closeTo;
      return {
        span: { from: start, to: closeTo },
        arrowSpan: { from: closeFrom, to: closeTo },
        style: kind === "--" ? "solid" : kind === "==" ? "thick" : "dotted",
        head: headOf(headCh),
        tailArrow: inlineOpen[1] === "<",
        label: unquote(p.text.slice(labelSpan.from, labelSpan.to)),
        labelSpan,
        labelKind: "inline",
      };
    }
  }

  const m = ARROW.exec(rest);
  if (!m) return undefined;
  const body = m[2];
  let headCh = m[3];
  // `--o` / `--x` only count as heads when not glued to a following ID (`---oB` is ambiguous).
  if (
    (headCh === "x" || headCh === "o") &&
    ID_CHAR.test(rest[m[0].length] ?? "")
  )
    headCh = "";
  const arrowLen = m[1].length + body.length + headCh.length;
  // `--` alone (without head) is not a link.
  if (body === "--" && !headCh) return undefined;
  if (body === "==" && !headCh) return undefined;

  p.pos = start + arrowLen;
  const link: Link = {
    span: { from: start, to: p.pos },
    arrowSpan: { from: start, to: p.pos },
    style: body.startsWith("=")
      ? "thick"
      : body.startsWith("~")
        ? "invisible"
        : body.includes(".")
          ? "dotted"
          : "solid",
    head: headOf(headCh),
    tailArrow: m[1] === "<",
  };

  // Optional pipe label: `-->|text|` (whitespace before `|` allowed)
  const save = p.pos;
  p.skipWs();
  if (p.peek() === "|") {
    const close = p.text.indexOf("|", p.pos + 1);
    if (close === -1 || close >= p.end)
      throw new SyntaxError_("Unclosed `|` label", p.pos, p.end);
    link.labelSpan = { from: p.pos + 1, to: close };
    link.label = unquote(p.text.slice(p.pos + 1, close));
    link.labelKind = "pipe";
    p.pos = close + 1;
    link.span.to = p.pos;
  } else {
    p.pos = save;
  }
  return link;
}

function headOf(ch: string): LinkHead {
  return ch === ">"
    ? "arrow"
    : ch === "x"
      ? "cross"
      : ch === "o"
        ? "circle"
        : "none";
}

function buildModel(result: Flowchart) {
  const byId = new Map<string, FlowNode>();
  const touch = (ref: NodeRef) => {
    let node = byId.get(ref.id);
    if (!node) {
      node = { id: ref.id, label: ref.id, shape: "rect", refs: [] };
      byId.set(ref.id, node);
    }
    node.refs.push(ref);
    if (ref.shape) {
      node.definedBy = ref;
      node.shape = ref.shape;
      node.label = ref.label ?? ref.id;
    }
  };

  result.statements.forEach((st, si) => {
    st.groups.forEach((g) => g.forEach(touch));
    st.links.forEach((_, li) => {
      for (const a of st.groups[li]) {
        for (const b of st.groups[li + 1]) {
          result.edges.push({
            id: `${si}:${li}:${a.id}:${b.id}`,
            from: a.id,
            to: b.id,
            statement: si,
            link: li,
          });
        }
      }
    });
  });
  result.nodes = [...byId.values()];
}

export function edgeLink(fc: Flowchart, edge: FlowEdge): Link {
  return fc.statements[edge.statement].links[edge.link];
}
