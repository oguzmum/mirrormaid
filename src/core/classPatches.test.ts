import { describe, expect, it } from "vitest";
import { parseClassDiagram, type ClassDiagram } from "./classDiagram";
import {
  addClass,
  addMember,
  addRelation,
  deleteClassElements,
  editMember,
  renameClass,
  setAnnotation,
  setRelationLabel,
  setRelationType,
} from "./classPatches";
import { applyChanges, type Change } from "./patches";

const run = (src: string, f: (d: ClassDiagram) => Change[]) => {
  const out = applyChanges(src, f(parseClassDiagram(src)));
  expect(parseClassDiagram(out).errors).toEqual([]);
  return out;
};

const SRC = `classDiagram
    class Animal {
        +String name
    }
    class Duck
    Animal <|-- Duck
    Duck : +swim()
`;

describe("class diagram patches", () => {
  it("adds classes and relations in canonical style", () => {
    expect(run(SRC, (d) => addClass(SRC, d, "Cat"))).toBe(
      SRC + "    class Cat\n",
    );
    expect(run(SRC, (d) => addRelation(SRC, d, "Cat", "Animal"))).toBe(
      SRC + "    Cat --> Animal\n",
    );
  });

  it("adds members into a body, creating one if needed", () => {
    expect(run(SRC, (d) => addMember(SRC, d, "Animal", "+int age"))).toContain(
      "    class Animal {\n        +String name\n        +int age\n    }\n",
    );
    expect(run(SRC, (d) => addMember(SRC, d, "Duck", "+quack()"))).toContain(
      "    class Duck {\n        +quack()\n    }\n",
    );
    const bare = "classDiagram\n  A --> B\n";
    expect(run(bare, (d) => addMember(bare, d, "B", "x"))).toBe(
      "classDiagram\n  A --> B\n  class B {\n      x\n  }\n",
    );
  });

  it("edits and deletes members", () => {
    expect(
      run(SRC, (d) => editMember(SRC, d, "Animal", 0, "-String id")),
    ).toContain("        -String id\n");
    expect(run(SRC, (d) => editMember(SRC, d, "Animal", 0, ""))).toContain(
      "    class Animal {\n    }\n",
    );
    expect(run(SRC, (d) => editMember(SRC, d, "Duck", 0, null))).not.toContain(
      "swim",
    );
    // The only line mentioning a class turns into a declaration.
    const only = "classDiagram\n  A : +x\n";
    expect(run(only, (d) => editMember(only, d, "A", 0, null))).toBe(
      "classDiagram\n  class A\n",
    );
  });

  it("renames a class everywhere, or its label", () => {
    const r = renameClass(parseClassDiagram(SRC), "Duck", "Goose");
    expect(r.newId).toBe("Goose");
    expect(applyChanges(SRC, r.changes)).toBe(SRC.replace(/Duck/g, "Goose"));
    expect(
      renameClass(parseClassDiagram(SRC), "Duck", "My duck").error,
    ).toMatch(/letters/);
    expect(renameClass(parseClassDiagram(SRC), "Duck", "Animal").error).toMatch(
      /exists/,
    );
    const labelled = 'classDiagram\n  class D["Duck"]\n';
    const l = renameClass(parseClassDiagram(labelled), "D", 'Big "D"');
    expect(l.newId).toBeUndefined();
    expect(applyChanges(labelled, l.changes)).toBe(
      'classDiagram\n  class D["Big #quot;D#quot;"]\n',
    );
  });

  it("sets, changes and removes annotations", () => {
    const withAnn = run(SRC, (d) =>
      setAnnotation(SRC, d, "Animal", "abstract"),
    );
    expect(withAnn).toContain(
      "class Animal {\n        <<abstract>>\n        +String name",
    );
    expect(
      run(withAnn, (d) => setAnnotation(withAnn, d, "Animal", "interface")),
    ).toContain("<<interface>>");
    expect(
      run(withAnn, (d) => setAnnotation(withAnn, d, "Animal", undefined)),
    ).toBe(SRC);
    expect(
      run(SRC, (d) => setAnnotation(SRC, d, "Duck", "enumeration")),
    ).toContain("    class Duck\n    <<enumeration>> Duck\n");
  });

  it("changes relation types on the marker's side, and labels", () => {
    const d = parseClassDiagram(SRC);
    expect(
      applyChanges(SRC, setRelationType(d.edges[0], "composition")),
    ).toContain("Animal *-- Duck");
    const plain = "classDiagram\n  A--B\n";
    const p = parseClassDiagram(plain);
    expect(
      applyChanges(plain, setRelationType(p.edges[0], "aggregation")),
    ).toBe("classDiagram\n  A --o B\n");
    const labelled = run(SRC, (x) => setRelationLabel(SRC, x.edges[0], "is a"));
    expect(labelled).toContain("Animal <|-- Duck : is a\n");
    expect(
      run(labelled, (x) => setRelationLabel(labelled, x.edges[0], " ")),
    ).toBe(SRC);
  });

  it("deletes classes with their lines and relations, keeping other classes", () => {
    expect(run(SRC, (d) => deleteClassElements(SRC, d, ["Duck"], []))).toBe(
      "classDiagram\n    class Animal {\n        +String name\n    }\n",
    );
    expect(run(SRC, (d) => deleteClassElements(SRC, d, ["Animal"], []))).toBe(
      "classDiagram\n    class Duck\n    Duck : +swim()\n",
    );
    const bare = "classDiagram\n  A --> B\n  class A\n";
    expect(
      run(bare, (d) => deleteClassElements(bare, d, [], [d.edges[0].id])),
    ).toBe("classDiagram\n  class B\n  class A\n");
  });
});
