# Architecture

| #   | View                        | Diagram type  | Question                                  |
| --- | --------------------------- | ------------- | ----------------------------------------- |
| 1   | [Modules](#1-modules)       | Flowchart     | What parts exist and who depends on whom? |
| 2   | [Data model](#2-data-model) | Class diagram | What does the parser produce?             |
| 3   | [Files](#3-files)           | Flowchart     | Where does the diagram live?              |

## 1. Modules

Two layers. `core/` is plain TypeScript without React, so it can be unit-tested and reused (e.g. in a VS Code extension later). `ui/` is React and owns all browser APIs. Dependencies only point from UI to core, never back.

```mermaid
flowchart TB
    subgraph UI["ui/ (React, browser)"]
        App["App.tsx<br/>state: code, layout, file"]
        Editor["CodeEditor.tsx<br/>CodeMirror 6"]
        Canvas["Canvas.tsx<br/>React Flow"]
        ClassNode["ClassNode.tsx<br/>UML class box, relation markers"]
        StateNode["StateNode.tsx<br/>state box, start/end, choice, fork/join"]
        FileIO["fileIO.ts<br/>File System Access API"]
        FileStore["fileStore.ts<br/>remembers open file (IndexedDB)"]
        Check["useMermaidCheck.ts<br/>lazy mermaid.parse"]
    end

    subgraph Core["core/ (pure TypeScript, tested)"]
        Diagram["diagram.ts<br/>picks the parser by header"]
        Parser["flowchart.ts<br/>span-aware parser"]
        Patches["patches.ts<br/>UI action → text changes"]
        ClassParser["classDiagram.ts<br/>span-aware parser"]
        ClassPatches["classPatches.ts<br/>UI action → text changes"]
        StateParser["stateDiagram.ts<br/>span-aware parser"]
        StatePatches["statePatches.ts<br/>UI action → text changes"]
        Block["layoutBlock.ts<br/>split / join layout block"]
        Auto["autoLayout.ts<br/>place missing nodes"]
    end

    subgraph Libs["external libraries"]
        CM[(CodeMirror)]
        RF[(React Flow)]
        Dagre[(dagre)]
        Mermaid[(mermaid.js)]
    end

    App --> Editor
    App --> Canvas
    App --> FileIO
    App --> FileStore
    App --> Check
    App --> Diagram
    App --> Patches
    App --> ClassPatches
    App --> StatePatches
    App --> Block
    App --> Auto

    Diagram --> Parser
    Diagram --> ClassParser
    Diagram --> StateParser
    Patches --> Parser
    ClassPatches --> ClassParser
    ClassPatches --> Patches
    StatePatches --> StateParser
    StatePatches --> Patches
    Auto --> Diagram
    Canvas --> ClassNode
    Canvas --> StateNode
    Auto --> Dagre
    Canvas --> Auto
    Editor --> CM
    Canvas --> RF
    Check -.->|loaded on demand| Mermaid
```

`mermaid.js` is only used to check "would GitHub render this?". It doesn't draw anything, because Mermaid can't place nodes at fixed positions and its parser has no source spans (see ADR-001, ADR-002).

## 2. Data model

What `parseFlowchart(text)` returns. The key idea of ADR-001: every token remembers its `Span` (start/end offset in the text), so a UI edit can patch exactly that spot.

```mermaid
classDiagram
    direction LR

    class Flowchart {
        +boolean ok
        +Direction direction
        +Span headerSpan
        +FlowNode[] nodes
        +FlowEdge[] edges
        +Statement[] statements
        +Span[] passthrough
        +ParseError[] errors
    }

    class Statement {
        +Span span
        +NodeRef[][] groups
        +Link[] links
    }

    class NodeRef {
        +string id
        +Span idSpan
        +Span span
        +Shape shape
        +string label
        +Span textSpan
    }

    class Link {
        +Span span
        +Span arrowSpan
        +LinkStyle style
        +LinkHead head
        +boolean tailArrow
        +string label
        +Span labelSpan
        +pipe|inline labelKind
    }

    class FlowNode {
        +string id
        +string label
        +Shape shape
        +NodeRef definedBy
        +NodeRef[] refs
    }

    class FlowEdge {
        +string id
        +string from
        +string to
        +number statement
        +number link
    }

    class Span {
        +number from
        +number to
    }

    class ParseError {
        +string message
        +number from
        +number to
    }

    class Change {
        +number from
        +number to
        +string insert
    }

    class Layout {
        <<Record~string, Pos~>>
    }

    class Pos {
        +number x
        +number y
    }

    Flowchart "1" *-- "*" Statement : source structure
    Flowchart "1" *-- "*" FlowNode : model
    Flowchart "1" *-- "*" FlowEdge : model
    Flowchart "1" *-- "*" ParseError
    Statement "1" *-- "1..*" NodeRef : groups
    Statement "1" *-- "*" Link
    FlowNode "1" o-- "1..*" NodeRef : occurrences
    FlowEdge ..> Statement : points to
    FlowEdge ..> Link : points to
    NodeRef ..> Span
    Link ..> Span
    Layout "1" o-- "*" Pos : by node ID
    Change ..> Span : same coordinates
```

Two views of the same text:

- **Source structure** (`Statement`, `NodeRef`, `Link`) mirrors the code exactly as written, including chains (`A --> B --> C`) and groups (`A & B --> C`). Patches work on this.
- **Model** (`FlowNode`, `FlowEdge`) is what the canvas draws. A node written three times in the code is one `FlowNode` with three `refs`. The last ref with a shape wins, like in Mermaid.

`Layout` is not part of the parse result. It lives next to the code and is joined with it only when the file is written (section 3).

## 3. Files

The diagram lives in a normal `.mmd` file on disk. The browser only keeps helpers.

```mermaid
flowchart LR
    File[("flow.mmd on disk<br/>code + layout block")]
    App["Mirrormaid<br/>code | layout"]
    IDB[("IndexedDB<br/>which file is open")]
    LS[("localStorage<br/>draft for crash recovery")]

    File -->|"open: splitFile()"| App
    App -->|"save / auto-save: joinFile()"| File
    App -.-> IDB
    App -.-> LS
```

- **New diagram:** lives in memory until the first save, which asks for a location.
- **Linked file:** every change is written automatically (auto-save) or with ⌘S. Opening alone never writes.
- **External edits** (VS Code, AI): picked up when the tab gets focus again. If Mirrormaid has unsaved edits at that moment, it asks instead of overwriting.
- Needs Chrome or Edge (File System Access API). Other browsers can only download.
