# ADR-001: Source of truth

**Date:** 2026-10-31

## Context

Mirrormaid keeps a code editor and a visual editor in sync live. The Mermaid code must stay clean and readable, because it lives in git and is read and rewritten by AI. Mermaid has no node positions, so layout data has to live somewhere else. Which representation is authoritative when either view changes?

## Options

1. **Text**: Mermaid text is the truth. UI edits rewrite the text (regex/line matching).
2. **Model**: An internal model is the truth. Text is regenerated from it by a serializer.
3. **Hybrid**: Text is the truth. A read-only model is parsed from it and keeps the **source span** of every node, edge and label. UI edits become small text patches at those spans.

## Evaluation

| Scenario                              | Text | Model | Hybrid |
| ------------------------------------- | ---- | ----- | ------ |
| Comment survives a UI edit            | ✅   | ❌    | ✅     |
| Unknown syntax (`classDef`, `style`…) | ✅   | ❌    | ✅     |
| Shorthand/formatting (`A --> B & C`)  | ⚠️   | ❌    | ✅     |
| Minimal git diffs, AI recognizes code | ✅   | ❌    | ✅     |
| Invalid code + UI edit                | ⚠️   | ❌    | ✅     |
| Effort per new diagram type           | ❌   | ⚠️    | ⚠️     |
| Move node / AI rewrites whole code    | ➖   | ➖    | ➖     |

- **Model** regenerates the whole text, so everything it doesn't represent is lost: comments, unknown syntax, the user's formatting. During invalid code, a UI edit would overwrite what the user is typing.
- **Text** keeps the code, but regex rewriting breaks on shorthand, and every UI action needs a rule for every syntax variant.
- **Hybrid** keeps the code byte for byte and patches precisely. The cost is a span-aware parser per diagram type.
- Positions don't separate the options: all of them need a layout store keyed by node ID (→ ADR-0002).

## Decision

**Option 3 (Hybrid).** User-written code is never lost or reformatted, which is the core promise of a git- and AI-friendly tool. Accept writing a span-aware parser per diagram type, because Mermaid's own parsers don't expose source positions (as far as I know).

## Consequences

- **Easier:** no full serializer, unsupported syntax is safe by default, minimal diffs, one undo stack in the editor.
- **Harder:** parser must track spans and skip unknown lines; each UI action needs a patch rule (incl. chains and `&` groups); inserted lines need a canonical style; the UI is read-only while the text is invalid.
- **Follow-up:** ADR-0002 (where positions live, how they survive big rewrites).
