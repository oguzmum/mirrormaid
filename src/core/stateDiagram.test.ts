import { describe, expect, it } from "vitest";
import { END_ID, START_ID, parseStateDiagram } from "./stateDiagram";
import { diagramKind, parseDiagram } from "./diagram";

const SRC = `stateDiagram-v2
    direction LR
    state "Waiting for input" as Idle
    state check <<choice>>
    [*] --> Idle
    Idle --> check : submit
    check --> Busy
    Busy : Working
    Busy : on it
    Busy --> [*]
    note right of Busy : takes a while
    Done
`;

describe("state diagram parser", () => {
  it("is picked by its header", () => {
    expect(diagramKind(SRC)).toBe("state");
    expect(diagramKind("stateDiagram\n  A --> B\n")).toBe("state");
    expect(parseDiagram(SRC).kind).toBe("state");
  });

  it("reads states, kinds, descriptions and transitions", () => {
    const d = parseStateDiagram(SRC);
    expect(d.errors).toEqual([]);
    expect(d.direction).toBe("LR");
    const by = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
    expect(Object.keys(by).sort()).toEqual(
      [START_ID, END_ID, "Busy", "Done", "Idle", "check"].sort(),
    );
    expect(by.Idle.label).toBe("Waiting for input");
    expect(by.Busy.label).toBe("Working\non it");
    expect(by.check.kind).toBe("choice");
    expect(by[START_ID].kind).toBe("start");
    expect(by[END_ID].kind).toBe("end");
    expect(by.Done.label).toBe("Done");
    expect(d.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      [START_ID, "Idle", undefined],
      ["Idle", "check", "submit"],
      ["check", "Busy", undefined],
      ["Busy", END_ID, undefined],
    ]);
  });

  it("tracks every mention of a state, including notes", () => {
    const d = parseStateDiagram(SRC);
    const busy = d.nodes.find((n) => n.id === "Busy")!;
    for (const s of busy.idSpans) expect(SRC.slice(s.from, s.to)).toBe("Busy");
    expect(busy.idSpans).toHaveLength(5);
  });

  it("keeps multi-line notes and styling as passthrough", () => {
    const src = `stateDiagram-v2
    A --> B
    note left of A
        line one
        line two
    end note
    classDef hot fill:#f00
    class A hot
`;
    const d = parseStateDiagram(src);
    expect(d.errors).toEqual([]);
    expect(d.passthrough).toHaveLength(3);
    expect(d.nodes.find((n) => n.id === "A")!.ownLines).toHaveLength(2);
  });

  it("reports what it doesn't support yet", () => {
    const composite = parseStateDiagram(
      "stateDiagram-v2\n  state Outer {\n    A --> B\n  }\n",
    );
    expect(composite.ok).toBe(false);
    expect(composite.errors[0].message).toMatch(/Composite/);
    expect(parseStateDiagram("stateDiagram-v2\n  A -> B\n").ok).toBe(false);
  });
});
