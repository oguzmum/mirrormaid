/**
 * Patch rules for class diagrams: every UI action becomes a small set of text
 * changes (ADR-001), like `patches.ts` does for flowcharts.
 *
 * Canonical style for inserted code: `    class Name { ... }` blocks, members on
 * their own lines inside the body, and `    A --> B` relations.
 */

import {
  isClassId,
  relationArrow,
  type ClassDiagram,
  type ClassNode,
  type Relation,
  type RelationType,
} from "./classDiagram";
import type { Span } from "./flowchart";
import { deleteLine, lineIndent, mergeOverlaps, type Change } from "./patches";

const UNIT = "    ";

/** Indentation for new top-level lines: the one of the first line after the header. */
function topIndent(text: string, d: ClassDiagram): string {
  if (!d.headerSpan) return UNIT;
  const rest = text.slice(d.headerSpan.to);
  const m = /\n([ \t]*)(?=\S)(?!%%)/.exec(rest);
  return m ? m[1] : UNIT;
}

function appendLines(text: string, d: ClassDiagram, lines: string[]): Change {
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

function find(d: ClassDiagram, id: string): ClassNode | undefined {
  return d.nodes.find((n) => n.id === id);
}

/** Indentation of members inside a class body. */
function memberIndent(text: string, node: ClassNode, declFrom: number) {
  const inBody = node.members.find(
    (m) => m.span === m.lineSpan && m.span.from > declFrom,
  );
  return inBody
    ? lineIndent(text, inBody.lineSpan.from)
    : lineIndent(text, declFrom) + UNIT;
}

export function nextClassId(d: ClassDiagram): string {
  const taken = new Set(d.nodes.map((n) => n.id));
  if (!taken.has("NewClass")) return "NewClass";
  for (let i = 2; ; i++) if (!taken.has(`NewClass${i}`)) return `NewClass${i}`;
}

// --- Classes -------------------------------------------------------------------

export function addClass(text: string, d: ClassDiagram, id: string): Change[] {
  return [appendLines(text, d, [`class ${id}`])];
}

/** The text a user edits when renaming: the explicit label if any, else the id. */
export function editableName(node: ClassNode): string {
  return node.labelSpan ? node.label : node.id;
}

export interface RenameResult {
  changes: Change[];
  /** Set when the id changed, so positions and routes can follow. */
  newId?: string;
  error?: string;
}

/**
 * Renames a class. A class with a `["Label"]` gets a new label; otherwise the
 * id is renamed at every occurrence (declaration, members, relations, styles).
 */
export function renameClass(
  d: ClassDiagram,
  id: string,
  name: string,
): RenameResult {
  const node = find(d, id);
  const clean = name.trim();
  if (!node || !clean || clean === editableName(node)) return { changes: [] };
  if (node.labelSpan) {
    return {
      changes: [
        {
          from: node.labelSpan.from,
          to: node.labelSpan.to,
          insert: clean.replace(/"/g, "#quot;"),
        },
      ],
    };
  }
  if (!isClassId(clean))
    return {
      changes: [],
      error: "Class names can only use letters, digits and `_`",
    };
  if (find(d, clean))
    return { changes: [], error: `A class named ${clean} already exists` };
  return {
    changes: node.idSpans.map((s) => ({
      from: s.from,
      to: s.to,
      insert: clean,
    })),
    newId: clean,
  };
}

export function setAnnotation(
  text: string,
  d: ClassDiagram,
  id: string,
  annotation: string | undefined,
): Change[] {
  const node = find(d, id);
  if (!node || node.annotation === annotation) return [];
  if (node.annotationSpan) {
    if (annotation)
      return [
        {
          from: node.annotationSpan.from,
          to: node.annotationSpan.to,
          insert: annotation,
        },
      ];
    const line = node.annotationLine!;
    return [deleteLine(text, line.from, line.to)];
  }
  if (!annotation) return [];
  const withBody = node.decls.find((c) => c.bodyOpen !== undefined);
  if (withBody) {
    const indent = memberIndent(text, node, withBody.span.from);
    return [
      {
        from: withBody.bodyOpen!,
        to: withBody.bodyOpen!,
        insert: `\n${indent}<<${annotation}>>`,
      },
    ];
  }
  const decl = node.decls[0];
  if (decl) {
    return [
      {
        from: decl.span.to,
        to: decl.span.to,
        insert: `\n${lineIndent(text, decl.span.from)}<<${annotation}>> ${id}`,
      },
    ];
  }
  return [appendLines(text, d, [`<<${annotation}>> ${id}`])];
}

// --- Members -------------------------------------------------------------------

export function addMember(
  text: string,
  d: ClassDiagram,
  id: string,
  member: string,
): Change[] {
  const node = find(d, id);
  const clean = member.trim();
  if (!node || !clean) return [];
  const withBody = node.decls.find((c) => c.closeSpan);
  if (withBody) {
    const indent = memberIndent(text, node, withBody.span.from);
    const at = lineStart(text, withBody.closeSpan!.from);
    return [{ from: at, to: at, insert: `${indent}${clean}\n` }];
  }
  const decl = node.decls[0];
  if (decl) {
    const indent = lineIndent(text, decl.span.from);
    return [
      {
        from: decl.span.to,
        to: decl.span.to,
        insert: ` {\n${indent}${UNIT}${clean}\n${indent}}`,
      },
    ];
  }
  return [appendLines(text, d, [`class ${id} {`, `${UNIT}${clean}`, "}"])];
}

/** Replaces a member's text, or deletes it when `member` is empty. */
export function editMember(
  text: string,
  d: ClassDiagram,
  id: string,
  index: number,
  member: string | null,
): Change[] {
  const node = find(d, id);
  const m = node?.members[index];
  if (!node || !m) return [];
  const clean = member?.trim();
  if (clean) return [{ from: m.span.from, to: m.span.to, insert: clean }];
  // Deleting the only line that mentions the class would delete the class, too.
  const onlyMention =
    m.span !== m.lineSpan &&
    node.idSpans.every(
      (s) => s.from >= m.lineSpan.from && s.to <= m.lineSpan.to,
    );
  if (onlyMention)
    return [
      { from: m.lineSpan.from, to: m.lineSpan.to, insert: `class ${id}` },
    ];
  return [deleteLine(text, m.lineSpan.from, m.lineSpan.to)];
}

// --- Relations -----------------------------------------------------------------

export function addRelation(
  text: string,
  d: ClassDiagram,
  from: string,
  to: string,
): Change[] {
  return [appendLines(text, d, [`${from} --> ${to}`])];
}

/** Changes the relation type, keeping the marker on the side it was on. */
export function setRelationType(rel: Relation, type: RelationType): Change[] {
  const side = rel.fromMarker && !rel.toMarker ? "left" : "right";
  return [
    {
      from: rel.arrowGap.from,
      to: rel.arrowGap.to,
      insert: ` ${relationArrow(type, side)} `,
    },
  ];
}

export function setRelationLabel(
  text: string,
  rel: Relation,
  label: string,
): Change[] {
  const clean = label.replace(/\s+/g, " ").trim();
  if (rel.labelSpan) {
    if (clean)
      return [
        { from: rel.labelSpan.from, to: rel.labelSpan.to, insert: clean },
      ];
    let from = text.lastIndexOf(":", rel.labelSpan.from);
    while (from > rel.span.from && /[ \t]/.test(text[from - 1])) from--;
    return [{ from, to: rel.labelSpan.to, insert: "" }];
  }
  if (!clean) return [];
  const dangling = text.slice(rel.span.from, rel.span.to).endsWith(":");
  return [
    {
      from: rel.span.to,
      to: rel.span.to,
      insert: dangling ? ` ${clean}` : ` : ${clean}`,
    },
  ];
}

// --- Deletion ------------------------------------------------------------------

/**
 * Deletes classes (with everything that belongs to them and their relations)
 * and relations. A class that is only mentioned in a deleted relation is kept
 * as a `class X` line in its place, so deleting a relation never deletes a class.
 */
export function deleteClassElements(
  text: string,
  d: ClassDiagram,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string>,
): Change[] {
  const removeNodes = new Set(nodeIds);
  const removeEdges = new Set(edgeIds);
  const gone: Span[] = [];
  for (const n of d.nodes) if (removeNodes.has(n.id)) gone.push(...n.ownLines);
  const rels = d.edges.filter(
    (r) =>
      removeEdges.has(r.id) || removeNodes.has(r.from) || removeNodes.has(r.to),
  );
  gone.push(...rels.map((r) => r.span));

  const inGone = (s: Span) =>
    gone.some((g) => s.from >= g.from && s.to <= g.to);
  const keepers = new Map<Relation, string[]>();
  for (const n of d.nodes) {
    if (removeNodes.has(n.id) || !n.idSpans.every(inGone)) continue;
    const rel = rels.find((r) => r.from === n.id || r.to === n.id);
    if (rel) keepers.set(rel, [...(keepers.get(rel) ?? []), n.id]);
  }

  const changes: Change[] = [];
  const seen = new Set<number>();
  for (const s of gone) {
    if (seen.has(s.from)) continue;
    seen.add(s.from);
    const rel = rels.find((r) => r.span === s);
    const keep = rel && keepers.get(rel);
    if (keep) {
      const indent = lineIndent(text, s.from);
      changes.push({
        from: s.from,
        to: s.to,
        insert: keep.map((id) => `class ${id}`).join(`\n${indent}`),
      });
    } else changes.push(deleteLine(text, s.from, s.to));
  }
  return mergeOverlaps(changes);
}
