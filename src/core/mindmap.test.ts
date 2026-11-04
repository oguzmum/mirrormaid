import { describe, expect, it } from "vitest";
import { parseMindmap, subtreeIds } from "./mindmap";
import { diagramKind, parseDiagram } from "./diagram";
import { mindmapLayout, mindmapNodeSize } from "./autoLayout";

const SRC = `mindmap
  root((Project))
    Goals
      [Fast sketching]
      ::icon(fa fa-bolt)
      id(Readable "code")
    %% a comment
    Risks
      ))Scope creep((
      )Cloudy(
      {{Hex}}
    Ideas
`;

const labels = (src: string) => parseMindmap(src).nodes.map((n) => n.label);

describe("mindmap parser", () => {
  it("is picked by its header", () => {
    expect(diagramKind(SRC)).toBe("mindmap");
    expect(parseDiagram(SRC).kind).toBe("mindmap");
  });

  it("reads nodes, shapes and the tree", () => {
    const d = parseMindmap(SRC);
    expect(d.errors).toEqual([]);
    expect(
      d.nodes.map((n) => [n.id, n.label, n.shape, n.depth, n.parent]),
    ).toEqual([
      ["n0", "Project", "circle", 0, undefined],
      ["n1", "Goals", "default", 1, "n0"],
      ["n2", "Fast sketching", "square", 2, "n1"],
      ["n3", 'Readable "code"', "rounded", 2, "n1"],
      ["n4", "Risks", "default", 1, "n0"],
      ["n5", "Scope creep", "bang", 2, "n4"],
      ["n6", "Cloudy", "cloud", 2, "n4"],
      ["n7", "Hex", "hexagon", 2, "n4"],
      ["n8", "Ideas", "default", 1, "n0"],
    ]);
    expect(d.edges).toHaveLength(8);
    expect(d.nodes.map((n) => n.branch)).toEqual([-1, 0, 0, 0, 1, 1, 1, 1, 2]);
    expect(d.passthrough).toHaveLength(1);
  });

  it("knows where each node and its subtree are", () => {
    const d = parseMindmap(SRC);
    const goals = d.nodes[1];
    expect(SRC.slice(goals.block.from, goals.block.to)).toBe(
      `    Goals
      [Fast sketching]
      ::icon(fa fa-bolt)
      id(Readable "code")`,
    );
    const square = d.nodes[2];
    expect(SRC.slice(square.textSpan.from, square.textSpan.to)).toBe(
      "Fast sketching",
    );
    const root = d.nodes[0];
    expect(SRC.slice(root.delims!.open.from, root.delims!.close.to)).toBe(
      "((Project))",
    );
    expect([...subtreeIds(d, "n4")]).toEqual(["n4", "n5", "n6", "n7"]);
  });

  it("finds parents like Mermaid: the closest node above with less indentation", () => {
    const d = parseMindmap("mindmap\n  A\n      B\n    C\n   D\n");
    expect(d.errors).toEqual([]);
    expect(d.nodes.map((n) => n.parent)).toEqual([undefined, "n0", "n0", "n0"]);
  });

  it("decodes quotes and entity codes", () => {
    expect(
      labels('mindmap\n  A["a (b)"]\n    f#40;x#41;\n    B["`**md**`"]\n'),
    ).toEqual(["a (b)", "f(x)", "**md**"]);
  });

  it("reports a second root and unknown lines", () => {
    const two = parseMindmap("mindmap\n  A\n  B\n");
    expect(two.ok).toBe(false);
    expect(two.errors[0].message).toMatch(/one root/);
    expect(parseMindmap("mindmap\n  A\n    B[x\n").ok).toBe(false);
    expect(parseMindmap("mindmap\n  A\n    B[x)\n").ok).toBe(false);
    expect(parseMindmap("mindmap\n  ::icon(x)\n").ok).toBe(false);
  });

  it("accepts an empty mindmap", () => {
    const d = parseMindmap("mindmap\n");
    expect(d.ok).toBe(true);
    expect(d.nodes).toEqual([]);
  });
});

describe("mindmap layout", () => {
  it("puts the root in the middle and branches on both sides without overlaps", () => {
    const d = parseMindmap(SRC);
    const l = mindmapLayout(d);
    const rects = d.nodes.map((n) => ({ ...l[n.id], ...mindmapNodeSize(n) }));
    const [root] = rects;
    expect(root.x + root.w / 2).toBeCloseTo(0, -1);
    // Goals goes right, Ideas left.
    expect(l.n1.x).toBeGreaterThan(root.x + root.w);
    expect(l.n8.x + rects[8].w).toBeLessThan(root.x);
    // Children are further out than their parent.
    expect(l.n2.x).toBeGreaterThan(l.n1.x);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        const overlap =
          a.x < b.x + b.w &&
          b.x < a.x + a.w &&
          a.y < b.y + b.h &&
          b.y < a.y + a.h;
        expect(overlap, `${d.nodes[i].label} / ${d.nodes[j].label}`).toBe(
          false,
        );
      }
  });
});
