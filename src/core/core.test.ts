import { describe, expect, it } from "vitest";
import { parseFlowchart } from "./flowchart";
import { joinFile, splitFile } from "./layoutBlock";
import {
  addEdge,
  addNode,
  applyChanges,
  deleteElements,
  renameNode,
  setEdgeLabel,
} from "./patches";
import { autoLayoutAll, placeMissing } from "./autoLayout";

const edgesOf = (src: string) =>
  parseFlowchart(src).edges.map((e) => `${e.from}->${e.to}`);

describe("parser", () => {
  it("reads header, nodes, shapes and labels", () => {
    const fc = parseFlowchart(
      `flowchart LR\n  A[Start] --> B(Round)\n  C{"Is it?"}\n  D((Circle))\n`,
    );
    expect(fc.ok).toBe(true);
    expect(fc.direction).toBe("LR");
    expect(fc.nodes.map((n) => [n.id, n.shape, n.label])).toEqual([
      ["A", "rect", "Start"],
      ["B", "round", "Round"],
      ["C", "diamond", "Is it?"],
      ["D", "circle", "Circle"],
    ]);
  });

  it("handles chains and & groups", () => {
    expect(edgesOf("graph TD\nA --> B --> C")).toEqual(["A->B", "B->C"]);
    expect(edgesOf("graph TD\nA & B --> C & D")).toEqual([
      "A->C",
      "A->D",
      "B->C",
      "B->D",
    ]);
    expect(edgesOf("graph TD\nA-->B;B-->C")).toEqual(["A->B", "B->C"]);
  });

  it("reads link styles and labels", () => {
    const fc = parseFlowchart(
      "graph LR\nA -->|yes| B\nB -- no --> C\nC -.-> D\nD ==> E\nE --- F\nF <--> G",
    );
    expect(fc.ok).toBe(true);
    const links = fc.statements.map((s) => s.links[0]);
    expect(links.map((l) => [l.style, l.head, l.label])).toEqual([
      ["solid", "arrow", "yes"],
      ["solid", "arrow", "no"],
      ["dotted", "arrow", undefined],
      ["thick", "arrow", undefined],
      ["solid", "none", undefined],
      ["solid", "arrow", undefined],
    ]);
    expect(links[5].tailArrow).toBe(true);
  });

  it("skips comments and passthrough lines", () => {
    const fc = parseFlowchart(
      "flowchart LR\n%% comment\nclassDef red fill:#f00\nsubgraph S [Group]\n  A --> B\nend\nstyle A fill:#0f0\n",
    );
    expect(fc.ok).toBe(true);
    expect(fc.passthrough).toHaveLength(4);
    expect(fc.nodes.map((n) => n.id)).toEqual(["A", "B"]);
  });

  it("last definition wins, like Mermaid", () => {
    const fc = parseFlowchart("flowchart LR\nA[One] --> B\nA[Two]");
    expect(fc.nodes[0].label).toBe("Two");
  });

  it("reports errors with positions", () => {
    const fc = parseFlowchart("flowchart LR\nA[Start --> B");
    expect(fc.ok).toBe(false);
    expect(fc.errors[0].message).toMatch(/Missing `]`/);
    expect(parseFlowchart("sequenceDiagram\nA->>B: hi").ok).toBe(false);
    expect(parseFlowchart("flowchart LR\nA -->").ok).toBe(false);
  });
});

describe("layout block", () => {
  const file = `flowchart LR\n  A --> B\n\n%% mirrormaid:layout v1 (generated, do not edit)\n%% A 120 80\n%% B 320 80\n%% /mirrormaid:layout\n`;

  it("round-trips", () => {
    const { code, layout } = splitFile(file);
    expect(code).toBe("flowchart LR\n  A --> B\n");
    expect(layout).toEqual({ A: { x: 120, y: 80 }, B: { x: 320, y: 80 } });
    expect(joinFile(code, layout)).toBe(file);
  });

  it("sorts, rounds and prunes orphans", () => {
    const out = joinFile(
      "flowchart LR\n  B --> A\n",
      { B: { x: 1.4, y: 2.6 }, A: { x: 0, y: 0 }, Z: { x: 9, y: 9 } },
      ["A", "B"],
    );
    expect(out).toContain("%% A 0 0\n%% B 1 3\n%% /mirrormaid");
    expect(out).not.toContain("Z");
  });

  it("ignores broken lines and keeps content after the block", () => {
    const { code, layout, ignoredLines } = splitFile(
      "flowchart LR\nA\n%% mirrormaid:layout v1\n%% A 1 2\n%% garbage\n%% /mirrormaid:layout\nB\n",
    );
    expect(layout).toEqual({ A: { x: 1, y: 2 } });
    expect(ignoredLines).toBe(1);
    expect(code).toBe("flowchart LR\nA\nB\n");
  });

  it("the whole file still parses as a flowchart", () => {
    expect(parseFlowchart(file).ok).toBe(true);
  });
});

describe("patches", () => {
  const run = (
    src: string,
    f: (fc: ReturnType<typeof parseFlowchart>) => ReturnType<typeof addNode>,
  ) => applyChanges(src, f(parseFlowchart(src)));

  it("renames a defined node in place, keeping everything else", () => {
    const src = "flowchart LR\n  %% keep me\n  A[Start] --> B\n";
    expect(run(src, (fc) => renameNode(fc, "A", "Begin"))).toBe(
      "flowchart LR\n  %% keep me\n  A[Begin] --> B\n",
    );
  });

  it("renames a bare node by adding a shape, quoting when needed", () => {
    const src = "flowchart LR\n  A --> B\n";
    expect(run(src, (fc) => renameNode(fc, "B", "Done (ok)"))).toBe(
      'flowchart LR\n  A --> B["Done (ok)"]\n',
    );
  });

  it("adds nodes and edges in canonical style with the existing indent", () => {
    const src = "flowchart LR\n  A --> B\n";
    expect(run(src, (fc) => addNode(src, fc, "n1", "New"))).toBe(
      "flowchart LR\n  A --> B\n  n1[New]\n",
    );
    expect(run(src, (fc) => addEdge(src, fc, "B", "A"))).toBe(
      "flowchart LR\n  A --> B\n  B --> A\n",
    );
  });

  it("sets, changes and removes edge labels", () => {
    const fc = parseFlowchart("flowchart LR\n  A --> B\n");
    const s1 = applyChanges(
      "flowchart LR\n  A --> B\n",
      setEdgeLabel(fc, fc.edges[0], "yes"),
    );
    expect(s1).toBe("flowchart LR\n  A -->|yes| B\n");
    const fc2 = parseFlowchart(s1);
    expect(applyChanges(s1, setEdgeLabel(fc2, fc2.edges[0], "no"))).toBe(
      "flowchart LR\n  A -->|no| B\n",
    );
    expect(applyChanges(s1, setEdgeLabel(fc2, fc2.edges[0], ""))).toBe(
      "flowchart LR\n  A --> B\n",
    );
    const s3 = "flowchart LR\n  A -- maybe --> B\n";
    const fc3 = parseFlowchart(s3);
    expect(applyChanges(s3, setEdgeLabel(fc3, fc3.edges[0], ""))).toBe(
      "flowchart LR\n  A --> B\n",
    );
  });

  it("deleting an edge keeps node definitions", () => {
    const src = "flowchart LR\n  A[Start] --> B[End]\n";
    const fc = parseFlowchart(src);
    expect(
      applyChanges(src, deleteElements(src, fc, [], [fc.edges[0].id])),
    ).toBe("flowchart LR\n  A[Start]\n  B[End]\n");
  });

  it("deleting an edge removes the line when nodes live elsewhere", () => {
    const src = "flowchart LR\n  A[Start]\n  B[End]\n  A --> B\n";
    const fc = parseFlowchart(src);
    expect(
      applyChanges(src, deleteElements(src, fc, [], [fc.edges[0].id])),
    ).toBe("flowchart LR\n  A[Start]\n  B[End]\n");
  });

  it("deleting a node removes its edges and leaves other code untouched", () => {
    const src =
      "flowchart LR\n  %% note\n  A --> B --> C\n  C --> D\n  style B fill:#f00\n  classDef x fill:#0f0\n";
    const fc = parseFlowchart(src);
    expect(applyChanges(src, deleteElements(src, fc, ["B"], []))).toBe(
      "flowchart LR\n  %% note\n  A\n  C --> D\n  classDef x fill:#0f0\n",
    );
  });

  it("deleting from a group splits the shared link", () => {
    const src = "flowchart LR\n  A & B --> C\n";
    const fc = parseFlowchart(src);
    const ac = fc.edges.find((e) => e.from === "A")!;
    expect(applyChanges(src, deleteElements(src, fc, [], [ac.id]))).toBe(
      "flowchart LR\n  B --> C\n  A\n",
    );
  });

  it("every patch result parses again", () => {
    const src =
      "flowchart TD\n  A[Start] -->|go| B{Check} --> C([Done])\n  B -.-> A\n";
    const fc = parseFlowchart(src);
    for (const n of fc.nodes) {
      expect(
        parseFlowchart(applyChanges(src, deleteElements(src, fc, [n.id], [])))
          .ok,
      ).toBe(true);
      expect(
        parseFlowchart(applyChanges(src, renameNode(fc, n.id, 'a "b" [c]'))).ok,
      ).toBe(true);
    }
    for (const e of fc.edges) {
      expect(
        parseFlowchart(applyChanges(src, deleteElements(src, fc, [], [e.id])))
          .ok,
      ).toBe(true);
      expect(
        parseFlowchart(applyChanges(src, setEdgeLabel(fc, e, "x|y"))).ok,
      ).toBe(true);
    }
  });
});

describe("auto layout", () => {
  it("lays out everything without positions", () => {
    const fc = parseFlowchart("flowchart LR\nA --> B --> C");
    const l = autoLayoutAll(fc);
    expect(Object.keys(l)).toEqual(["A", "B", "C"]);
    expect(l.A.x).toBeLessThan(l.B.x);
  });

  it("only places missing nodes, next to their neighbour", () => {
    const fc = parseFlowchart("flowchart LR\nA --> B\nB --> C");
    const placed = placeMissing(fc, {
      A: { x: 1000, y: 500 },
      B: { x: 1200, y: 500 },
    });
    expect(Object.keys(placed)).toEqual(["C"]);
    expect(placed.C.x).toBeGreaterThan(1200);
    expect(Math.abs(placed.C.y - 500)).toBeLessThan(100);
  });
});
