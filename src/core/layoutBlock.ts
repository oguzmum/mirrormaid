/**
 * The hidden layout block (ADR-002, option 1c).
 *
 * On disk, positions live in a Mermaid comment block at the end of the file:
 *
 *   %% mirrormaid:layout v1 (generated, do not edit)
 *   %% A 120 80
 *   %% /mirrormaid:layout
 *
 * In the app, the file is split into the visible code (what the editor shows)
 * and a position map. They are only joined again on save, so the editor never
 * sees the block and UI patches can't touch it.
 */

export interface Pos {
  x: number;
  y: number;
}

export type Layout = Record<string, Pos>;

const START = "%% mirrormaid:layout v1 (generated, do not edit)";
const START_RE = /^[ \t]*%%[ \t]*mirrormaid:layout\b.*$/m;
const END_RE = /^[ \t]*%%[ \t]*\/mirrormaid:layout[ \t]*$/m;
const ENTRY_RE =
  /^[ \t]*%%[ \t]*(\S+)[ \t]+(-?\d+(?:\.\d+)?)[ \t]+(-?\d+(?:\.\d+)?)[ \t]*$/;

export interface SplitFile {
  code: string;
  layout: Layout;
  /** Lines inside the block that could not be read. They are dropped on save. */
  ignoredLines: number;
}

export function splitFile(text: string): SplitFile {
  const normalized = text.replace(/\r\n?/g, "\n");
  const start = START_RE.exec(normalized);
  if (!start) return { code: normalized, layout: {}, ignoredLines: 0 };

  const before = normalized.slice(0, start.index);
  const afterStart = normalized.slice(start.index + start[0].length);
  const end = END_RE.exec(afterStart);
  const body = end ? afterStart.slice(0, end.index) : afterStart;
  const after = end ? afterStart.slice(end.index + end[0].length) : "";

  const layout: Layout = {};
  let ignoredLines = 0;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const m = ENTRY_RE.exec(line);
    if (m)
      layout[m[1]] = {
        x: Math.round(Number(m[2])),
        y: Math.round(Number(m[3])),
      };
    else ignoredLines++;
  }

  // Anything after the block is user content that ended up there; keep it.
  let code = before.replace(/\s+$/, "");
  if (after.trim()) code += "\n" + after.replace(/^\n/, "").replace(/\s+$/, "");
  return { code: code + "\n", layout, ignoredLines };
}

/**
 * Joins visible code and positions into the file format.
 * `keep` limits the block to existing node IDs (orphans are pruned on save).
 */
export function joinFile(
  code: string,
  layout: Layout,
  keep?: Iterable<string>,
): string {
  const base = code.replace(/\s+$/, "") + "\n";
  const ids = keep
    ? [...new Set(keep)].filter((id) => layout[id])
    : Object.keys(layout);
  if (ids.length === 0) return base;
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = ids.map(
    (id) => `%% ${id} ${Math.round(layout[id].x)} ${Math.round(layout[id].y)}`,
  );
  return `${base}\n${START}\n${lines.join("\n")}\n%% /mirrormaid:layout\n`;
}
