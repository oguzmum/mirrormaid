/**
 * The diagram type is decided by the header line of the code (ADR-004), so the
 * text stays the single source of truth (ADR-001) and there is no separate mode.
 */

import { parseFlowchart, type Flowchart } from "./flowchart";
import { parseClassDiagram, type ClassDiagram } from "./classDiagram";

export type Diagram = Flowchart | ClassDiagram;
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
    return /^classDiagram\b/.test(line) ? "class" : "flowchart";
  }
  return "flowchart";
}

export function parseDiagram(text: string): Diagram {
  return diagramKind(text) === "class"
    ? parseClassDiagram(text)
    : parseFlowchart(text);
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
};
