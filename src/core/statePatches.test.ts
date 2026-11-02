import { describe, expect, it } from "vitest";
import {
  END_ID,
  START_ID,
  parseStateDiagram,
  type StateDiagram,
} from "./stateDiagram";
import {
  addState,
  addTransition,
  connectPseudo,
  deleteStateElements,
  renameState,
  setStateKind,
  setTransitionLabel,
} from "./statePatches";
import { applyChanges, type Change } from "./patches";

const run = (src: string, f: (d: StateDiagram) => Change[]) => {
  const out = applyChanges(src, f(parseStateDiagram(src)));
  expect(parseStateDiagram(out).errors).toEqual([]);
  return out;
};

const SRC = `stateDiagram-v2
    [*] --> Idle
    Idle --> Busy : start
    Busy --> [*]
`;

const edge = (d: StateDiagram, from: string, to: string) =>
  d.edges.find((e) => e.from === from && e.to === to)!;

describe("state diagram patches", () => {
  it("adds states and transitions in canonical style", () => {
    expect(run(SRC, (d) => addState(SRC, d, "Done"))).toBe(SRC + "    Done\n");
    expect(run(SRC, (d) => addTransition(SRC, d, "Busy", "Idle").changes)).toBe(
      SRC + "    Busy --> Idle\n",
    );
    expect(run(SRC, (d) => connectPseudo(SRC, d, "Idle", "end"))).toBe(
      SRC + "    Idle --> [*]\n",
    );
  });

  it("flips connections drawn into start or out of end", () => {
    const d = parseStateDiagram(SRC);
    expect(
      applyChanges(SRC, addTransition(SRC, d, "Busy", START_ID).changes),
    ).toBe(SRC + "    [*] --> Busy\n");
    expect(
      applyChanges(SRC, addTransition(SRC, d, END_ID, "Idle").changes),
    ).toBe(SRC + "    Idle --> [*]\n");
    expect(addTransition(SRC, d, START_ID, END_ID).error).toBeDefined();
  });

  it("renames the id everywhere, or adds a description for free text", () => {
    const r = renameState(SRC, parseStateDiagram(SRC), "Idle", "Ready");
    expect(r.newId).toBe("Ready");
    expect(applyChanges(SRC, r.changes)).toBe(SRC.replace(/Idle/g, "Ready"));
    expect(
      run(SRC, (d) => renameState(SRC, d, "Busy", "Doing work").changes),
    ).toBe(SRC.replace("start\n", "start\n    Busy : Doing work\n"));
  });

  it("edits an existing description and merges extra ones", () => {
    const src = `stateDiagram-v2
    state "Old" as A
    A : more
    A --> B
`;
    expect(run(src, (d) => renameState(src, d, "A", 'Say "hi"').changes)).toBe(
      `stateDiagram-v2
    state "Say #quot;hi#quot;" as A
    A --> B
`,
    );
  });

  it("changes the state type before the first mention", () => {
    expect(run(SRC, (d) => setStateKind(SRC, d, "Busy", "choice"))).toBe(
      SRC.replace(
        "    Idle --> Busy",
        "    state Busy <<choice>>\n    Idle --> Busy",
      ),
    );
    const typed = "stateDiagram-v2\n  state f <<fork>>\n  f --> A\n";
    expect(run(typed, (d) => setStateKind(typed, d, "f", "join"))).toBe(
      typed.replace("fork", "join"),
    );
    expect(run(typed, (d) => setStateKind(typed, d, "f", "state"))).toBe(
      "stateDiagram-v2\n  f --> A\n",
    );
    const alone = "stateDiagram-v2\n  state f <<fork>>\n";
    expect(run(alone, (d) => setStateKind(alone, d, "f", "state"))).toBe(
      "stateDiagram-v2\n  f\n",
    );
  });

  it("sets, changes and removes transition labels", () => {
    expect(
      run(SRC, (d) => setTransitionLabel(SRC, edge(d, "Idle", "Busy"), "go")),
    ).toContain("Idle --> Busy : go\n");
    expect(
      run(SRC, (d) => setTransitionLabel(SRC, edge(d, "Idle", "Busy"), "")),
    ).toContain("    Idle --> Busy\n");
    expect(
      run(SRC, (d) => setTransitionLabel(SRC, edge(d, "Busy", END_ID), "ok")),
    ).toContain("Busy --> [*] : ok\n");
  });

  it("deletes a transition but keeps states only mentioned there", () => {
    expect(
      run(SRC, (d) =>
        deleteStateElements(SRC, d, [], [edge(d, "Idle", "Busy").id]),
      ),
    ).toBe(`stateDiagram-v2
    [*] --> Idle
    Busy --> [*]
`);
    const src = "stateDiagram-v2\n    A --> B\n";
    expect(
      run(src, (d) => deleteStateElements(src, d, [], [d.edges[0].id])),
    ).toBe("stateDiagram-v2\n    A\n    B\n");
  });

  it("deletes a state with its transitions, descriptions and notes", () => {
    const src = `stateDiagram-v2
    [*] --> Idle
    Idle --> Busy
    Busy : Working
    note right of Busy
        slow
    end note
    Busy --> [*]
`;
    expect(run(src, (d) => deleteStateElements(src, d, ["Busy"], []))).toBe(
      "stateDiagram-v2\n    [*] --> Idle\n",
    );
    expect(run(SRC, (d) => deleteStateElements(SRC, d, [START_ID], []))).toBe(
      "stateDiagram-v2\n    Idle --> Busy : start\n    Busy --> [*]\n",
    );
  });
});
