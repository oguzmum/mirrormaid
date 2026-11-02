/**
 * The diagram type is decided by the header line of the code (ADR-004), so the
 * text stays the single source of truth (ADR-001) and there is no separate mode.
 */

import { parseFlowchart, type Flowchart } from "./flowchart";
import { parseClassDiagram, type ClassDiagram } from "./classDiagram";
import { parseStateDiagram, type StateDiagram } from "./stateDiagram";

export type Diagram = Flowchart | ClassDiagram | StateDiagram;
export type DiagramKind = Diagram["kind"];

/** What layout and routing need from any diagram: nodes and edges by ID. */
export interface Graph {
  direction: Diagram["direction"];
  nodes: { id: string }[];
  edges: { id: string; from: string; to: string }[];
}

export function diagramKind(text: string): DiagramKind {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue;
    if (/^classDiagram\b/.test(line)) return "class";
    if (/^stateDiagram\b/.test(line)) return "state";
    return "flowchart";
  }
  return "flowchart";
}

export function parseDiagram(text: string): Diagram {
  switch (diagramKind(text)) {
    case "class":
      return parseClassDiagram(text);
    case "state":
      return parseStateDiagram(text);
    default:
      return parseFlowchart(text);
  }
}

export const TEMPLATES: Record<DiagramKind, string> = {
  flowchart: "flowchart LR\n    A[Start] --> B[End]\n",
  class: `classDiagram
    class Animal {
        <<abstract>>
        +String name
        +makeSound() void
    }
    class Dog {
        +fetch() void
    }
    Animal <|-- Dog
`,
  state: `stateDiagram-v2
    [*] --> Idle
    Idle --> Busy : start
    Busy --> Idle : done
    Busy --> [*]
`,
};
