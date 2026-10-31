import { describe, expect, it } from "vitest";
import {
  displayMember,
  parseClassDiagram,
  relationArrow,
  relationType,
} from "./classDiagram";
import { parseDiagram } from "./diagram";

const SRC = `classDiagram
    direction LR
    %% a comment
    class Animal {
        <<abstract>>
        +String name
        +makeSound()* void
    }
    class Square~Shape~
    class Duck["Rubber duck"]
    Animal : +int age
    <<interface>> Swimmer
    Animal <|-- Duck
    Animal "1" *-- "many" Leg : has
    Duck ..|> Swimmer
    Foo--order
    A o-- B
    style Duck fill:#f9f
    note for Duck "quack"
`;

describe("class diagram parser", () => {
  const d = parseClassDiagram(SRC);

  it("reads classes, members, labels and annotations", () => {
    expect(d.errors).toEqual([]);
    expect(d.ok).toBe(true);
    expect(d.direction).toBe("LR");
    const animal = d.nodes.find((n) => n.id === "Animal")!;
    expect(animal.annotation).toBe("abstract");
    expect(animal.members.map((m) => [m.text, m.kind])).toEqual([
      ["+String name", "attribute"],
      ["+makeSound()* void", "method"],
      ["+int age", "attribute"],
    ]);
    expect(d.nodes.find((n) => n.id === "Square")!.label).toBe("Square<Shape>");
    expect(d.nodes.find((n) => n.id === "Duck")!.label).toBe("Rubber duck");
    expect(d.nodes.find((n) => n.id === "Swimmer")!.annotation).toBe(
      "interface",
    );
  });

  it("reads relations with markers, cardinalities and labels", () => {
    const rels = d.edges.map((r) => ({
      from: r.from,
      to: r.to,
      type: relationType(r),
      fromCard: r.fromCard,
      toCard: r.toCard,
      label: r.label,
    }));
    expect(rels).toEqual(
      [
        { from: "Animal", to: "Duck", type: "inheritance" },
        {
          from: "Animal",
          to: "Leg",
          type: "composition",
          fromCard: "1",
          toCard: "many",
          label: "has",
        },
        { from: "Duck", to: "Swimmer", type: "realization" },
        { from: "Foo", to: "order", type: "link" },
        { from: "A", to: "B", type: "aggregation" },
      ].map((r) => ({
        fromCard: undefined,
        toCard: undefined,
        label: undefined,
        ...r,
      })),
    );
    expect(d.edges[0].fromMarker).toBe("triangle");
    expect(d.edges[2].toMarker).toBe("triangle");
  });

  it("tracks every id occurrence and the lines owned by a class", () => {
    const duck = d.nodes.find((n) => n.id === "Duck")!;
    expect(duck.idSpans.map((s) => SRC.slice(s.from, s.to))).toEqual(
      Array(5).fill("Duck"),
    );
    expect(duck.ownLines.map((s) => SRC.slice(s.from, s.to))).toEqual([
      'class Duck["Rubber duck"]',
      "style Duck fill:#f9f",
      'note for Duck "quack"',
    ]);
  });

  it("reports unknown lines and unclosed bodies", () => {
    expect(parseClassDiagram("classDiagram\n  what is this\n").ok).toBe(false);
    const open = parseClassDiagram("classDiagram\n  class A {\n  +x\n");
    expect(open.errors[0].message).toMatch(/Missing `}`/);
  });

  it("picks the parser from the header", () => {
    expect(parseDiagram("%% hi\nclassDiagram\n").kind).toBe("class");
    expect(parseDiagram("flowchart LR\nA-->B\n").kind).toBe("flowchart");
  });

  it("writes arrows on either side and displays members", () => {
    expect(relationArrow("inheritance", "left")).toBe("<|--");
    expect(relationArrow("realization", "right")).toBe("..|>");
    expect(relationArrow("aggregation", "right")).toBe("--o");
    expect(relationArrow("dashed-link", "left")).toBe("..");
    expect(displayMember("+getAll()$ List~List~int~~")).toEqual({
      text: "+getAll() List<List<int>>",
      isStatic: true,
      isAbstract: false,
    });
    expect(displayMember("+count$").isStatic).toBe(true);
  });
});
