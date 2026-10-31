/**
 * The hidden layout block (ADR-002, option 1c).
 *
 * On disk, positions live in a Mermaid comment block at the end of the file:
 *
 *   %% mirrormaid:layout v1 (generated, do not edit)
 *   %% A 120 80
 *   %% A->B 200 80 200 160
 *   %% /mirrormaid:layout
 *
 * Node lines hold `<id> <x> <y>`. Edge lines hold `<from>-><to>` followed by the
 * waypoints of a manually drawn route (ADR-003). A second edge between the same
 * nodes is keyed `A->B#2`, and so on.
 *
 * In the app, the file is split into the visible code (what the editor shows)
 * and a position map. They are only joined again on save, so the editor never
 * sees the block and UI patches can't touch it.
 */

import type { Flowchart } from "./flowchart";

export interface Pos {
  x: number;
  y: number;
}

export type Layout = Record<string, Pos>;

/** Manually drawn edge routes: waypoints between source and target, by route key. */
export type Routes = Record<string, Pos[]>;

/**
 * Route key per edge ID: `A->B`, and `A->B#2`, `A->B#3` for further edges
 * between the same two nodes, counted in source order. Unlike edge IDs these
 * survive reordering statements and edits elsewhere in the code.
 */
export function routeKeys(fc: Flowchart): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const e of fc.edges) {
    const base = `${e.from}->${e.to}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(e.id, n === 1 ? base : `${base}#${n}`);
  }
  return out;
}

const START = "%% mirrormaid:layout v1 (generated, do not edit)";
const START_RE = /^[ \t]*%%[ \t]*mirrormaid:layout\b.*$/m;
const END_RE = /^[ \t]*%%[ \t]*\/mirrormaid:layout[ \t]*$/m;
const NUM = String.raw`-?\d+(?:\.\d+)?`;
const ROUTE_RE = new RegExp(
  String.raw`^[ \t]*%%[ \t]*(\S+->\S+?)((?:[ \t]+${NUM}[ \t]+${NUM})+)[ \t]*$`,
);
const ENTRY_RE =
  /^[ \t]*%%[ \t]*(\S+)[ \t]+(-?\d+(?:\.\d+)?)[ \t]+(-?\d+(?:\.\d+)?)[ \t]*$/;

export interface SplitFile {
  code: string;
  layout: Layout;
  routes: Routes;
  /** Lines inside the block that could not be read. They are dropped on save. */
  ignoredLines: number;
}

export function splitFile(text: string): SplitFile {
  const normalized = text.replace(/\r\n?/g, "\n");
  const start = START_RE.exec(normalized);
  if (!start)
    return { code: normalized, layout: {}, routes: {}, ignoredLines: 0 };

  const before = normalized.slice(0, start.index);
  const afterStart = normalized.slice(start.index + start[0].length);
  const end = END_RE.exec(afterStart);
  const body = end ? afterStart.slice(0, end.index) : afterStart;
  const after = end ? afterStart.slice(end.index + end[0].length) : "";

  const layout: Layout = {};
  const routes: Routes = {};
  let ignoredLines = 0;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const r = ROUTE_RE.exec(line);
    if (r) {
      const nums = r[2]
        .trim()
        .split(/[ \t]+/)
        .map((v) => Math.round(+v));
      const pts: Pos[] = [];
      for (let i = 0; i < nums.length; i += 2)
        pts.push({ x: nums[i], y: nums[i + 1] });
      routes[r[1]] = pts;
      continue;
    }
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
  return { code: code + "\n", layout, routes, ignoredLines };
}

/**
 * Joins visible code and positions into the file format.
 * `keep` limits the block to existing node IDs and route keys (orphans are
 * pruned on save).
 */
export function joinFile(
  code: string,
  layout: Layout,
  keep?: { nodes: Iterable<string>; routes: Iterable<string> },
  routes: Routes = {},
): string {
  const base = code.replace(/\s+$/, "") + "\n";
  const pick = (all: object, ids?: Iterable<string>) =>
    (ids
      ? [...new Set(ids)].filter((id) => Object.hasOwn(all, id))
      : Object.keys(all)
    ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const nodeIds = pick(layout, keep?.nodes);
  const routeIds = pick(routes, keep?.routes).filter(
    (k) => routes[k].length > 0,
  );
  if (nodeIds.length + routeIds.length === 0) return base;
  const xy = (p: Pos) => `${Math.round(p.x)} ${Math.round(p.y)}`;
  const lines = [
    ...nodeIds.map((id) => `%% ${id} ${xy(layout[id])}`),
    ...routeIds.map((k) => `%% ${k} ${routes[k].map(xy).join(" ")}`),
  ];
  return `${base}\n${START}\n${lines.join("\n")}\n%% /mirrormaid:layout\n`;
}
