import { describe, expect, it } from "vitest";
import { parseMindmap, type Mindmap } from "./mindmap";
import {
  addMindmapChild,
  addMindmapSibling,
  deleteMindmapNodes,
  idAfterSiblingMove,
  moveMindmapNode,
  moveMindmapSibling,
  setMindmapShape,
  setMindmapText,
} from "./mindmapPatches";
import { applyChanges, type Change } from "./patches";

const run = (src: string, f: (d: Mindmap) => Change[]) => {
  const out = applyChanges(src, f(parseMindmap(src)));
  expect(parseMindmap(out).errors).toEqual([]);
  return out;
};

const SRC = `mindmap
  root((Project))
    Goals
      Fast
      Clean
    Risks
`;

describe("mindmap patches", () => {
  it("adds children at the end of the branch, with the siblings' indentation", () => {
    const d = parseMindmap(SRC);
    const r = addMindmapChild(SRC, d, "n1");
    const out = applyChanges(SRC, r.changes);
    expect(out).toBe(SRC.replace("Clean\n", "Clean\n      New idea\n"));
    expect(r.id).toBe("n4");
    expect(parseMindmap(out).nodes[4].label).toBe("New idea");
  });

  it("indents a first child one step deeper", () => {
    const r = addMindmapChild(SRC, parseMindmap(SRC), "n4");
    expect(applyChanges(SRC, r.changes)).toBe(SRC + "      New idea\n");
    expect(r.id).toBe("n5");
  });

  it("adds siblings right after the node's branch", () => {
    const d = parseMindmap(SRC);
    const r = addMindmapSibling(SRC, d, "n1");
    expect(applyChanges(SRC, r.changes)).toBe(
      SRC.replace("Clean\n", "Clean\n    New idea\n"),
    );
    expect(r.id).toBe("n4");
    // The root has no siblings, so it gets a child.
    expect(applyChanges(SRC, addMindmapSibling(SRC, d, "n0").changes)).toBe(
      SRC + "    New idea\n",
    );
  });

  it("adds a root to an empty mindmap", () => {
    const src = "mindmap\n";
    const r = addMindmapChild(src, parseMindmap(src), undefined, "Center");
    expect(applyChanges(src, r.changes)).toBe("mindmap\n  Center\n");
    expect(r.id).toBe("n0");
  });

  it("edits text, escaping what would break the syntax", () => {
    expect(run(SRC, (d) => setMindmapText(d, "n1", "Aims"))).toBe(
      SRC.replace("Goals", "Aims"),
    );
    expect(run(SRC, (d) => setMindmapText(d, "n1", "f(x)"))).toBe(
      SRC.replace("Goals", "f#40;x#41;"),
    );
    expect(run(SRC, (d) => setMindmapText(d, "n0", 'Say "hi" (now)'))).toBe(
      SRC.replace("Project", '"Say #quot;hi#quot; (now)"'),
    );
    const out = run(SRC, (d) => setMindmapText(d, "n0", 'Say "hi" (now)'));
    expect(parseMindmap(out).nodes[0].label).toBe('Say "hi" (now)');
  });

  it("changes shapes, keeping ids between bracket shapes", () => {
    expect(run(SRC, (d) => setMindmapShape(d, "n0", "square"))).toBe(
      SRC.replace("root((Project))", "root[Project]"),
    );
    expect(run(SRC, (d) => setMindmapShape(d, "n0", "bang"))).toBe(
      SRC.replace("root((Project))", "root))Project(("),
    );
    expect(run(SRC, (d) => setMindmapShape(d, "n0", "default"))).toBe(
      SRC.replace("root((Project))", "Project"),
    );
    expect(run(SRC, (d) => setMindmapShape(d, "n1", "cloud"))).toBe(
      SRC.replace("Goals", ")Goals("),
    );
  });

  it("deletes whole branches but never the root", () => {
    expect(run(SRC, (d) => deleteMindmapNodes(SRC, d, ["n1"]).changes)).toBe(
      "mindmap\n  root((Project))\n    Risks\n",
    );
    expect(
      run(SRC, (d) => deleteMindmapNodes(SRC, d, ["n1", "n2", "n4"]).changes),
    ).toBe("mindmap\n  root((Project))\n");
    const r = deleteMindmapNodes(SRC, parseMindmap(SRC), ["n0"]);
    expect(r.changes).toEqual([]);
    expect(r.error).toBeDefined();
  });

  it("moves a branch under another node", () => {
    expect(run(SRC, (d) => moveMindmapNode(SRC, d, "n1", "n4").changes))
      .toBe(`mindmap
  root((Project))
    Risks
      Goals
        Fast
        Clean
`);
    // Up the tree, when the moved node is the last thing in the target's branch.
    expect(run(SRC, (d) => moveMindmapNode(SRC, d, "n3", "n0").changes))
      .toBe(`mindmap
  root((Project))
    Goals
      Fast
    Risks
    Clean
`);
    // Into a later sibling's branch, from before it.
    expect(run(SRC, (d) => moveMindmapNode(SRC, d, "n2", "n4").changes))
      .toBe(`mindmap
  root((Project))
    Goals
      Clean
    Risks
      Fast
`);
    const d = parseMindmap(SRC);
    expect(moveMindmapNode(SRC, d, "n1", "n2").error).toBeDefined();
    expect(moveMindmapNode(SRC, d, "n0", "n4").error).toBeDefined();
    expect(moveMindmapNode(SRC, d, "n2", "n1").changes).toEqual([]);
  });

  it("swaps siblings and tells where the node went", () => {
    const d = parseMindmap(SRC);
    expect(run(SRC, () => moveMindmapSibling(SRC, d, "n4", -1))).toBe(`mindmap
  root((Project))
    Risks
    Goals
      Fast
      Clean
`);
    expect(idAfterSiblingMove(d, "n4", -1)).toBe("n1");
    expect(idAfterSiblingMove(d, "n1", 1)).toBe("n2");
    expect(run(SRC, () => moveMindmapSibling(SRC, d, "n2", 1))).toBe(
      SRC.replace("Fast\n      Clean", "Clean\n      Fast"),
    );
    expect(moveMindmapSibling(SRC, d, "n4", 1)).toEqual([]);
  });
});
