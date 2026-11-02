# Mirrormaid

Edit Mermaid diagrams visually and as code, with both views kept in sync live.

## Motivation

I often use Mermaid for diagrams, but writing it by hand is slow when I just want to sketch an idea. For fast thinking I switch to draw.io.

draw.io is great, and it can even insert Mermaid diagrams. But you can't visually edit inserted Mermaid, and the Mermaid code doesn't update when you change things in the UI.

That hurts because I often discuss design and architecture decisions with AI. AI reads and writes Mermaid well, but draw.io's XML is hard to read for humans, and I don't want to feed it to an AI either. So I keep copy-pasting Mermaid and redoing changes I already made in the draw.io UI.

So I want a tool where I can edit a diagram visually AND as Mermaid code, and both stay in sync live.

## Goals

- **Two-way live sync:** edit Mermaid → diagram updates; edit diagram → Mermaid updates
- **Stable layout:** after saving and reopening, every node is where I left it
- **Clean Mermaid code:** the code stays readable, so I can paste it to and from AI. Layout is stored in a hidden comment block at the end of the file, so the file stays valid Mermaid and still renders on GitHub ([ADR-0002](docs/adr/002-node-positions.md))
- **Local only:** no account, no cloud

## Non-goals

- Real-time collaboration with other people
- A full draw.io replacement (free shapes, styling everything, arbitrary drawings)
- Cloud sync or hosting

## Roadmap

1. **MVP: flowchart only.** Nodes and edges, rename/add/delete in both views, positions saved. One diagram per file. ✅
2. Export PNG / SVG
3. More diagram types, one at a time: class ✅ → state ✅ → ER → sequence → mindmap. Free positioning may not make sense for every type (e.g. sequence diagrams are ordered by their code, mindmaps are laid out automatically).
4. Multiple sheets per file, each sheet holding one diagram. This changes the file format, so it needs its own ADR.
5. PDF export

## Architecture decisions

I'm also using this project to learn software architecture. Every important decision is written down as an [Architecture Decision Record](https://adr.github.io/) (ADR). Each one describes the context, the options, how they compare in concrete scenarios, and what the decision costs.

| ADR                                     | Title                                            |
| --------------------------------------- | ------------------------------------------------ |
| [0001](docs/adr/001-source-of-truth.md) | Source of truth: Mermaid text vs. internal model |
| [0002](docs/adr/002-node-positions.md)  | Where node positions live                        |
| [0003](docs/adr/003-edge-routes.md)     | Manually drawn edge routes                       |

Open questions that will get their own ADR:

- Parser approach: hand-written vs. a parser generator with source positions
- File format for multiple sheets per file
