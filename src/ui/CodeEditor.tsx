import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Change } from "../core/patches";
import type { ParseError } from "../core/flowchart";

/** Small highlighter for flowchart syntax. Display only, the real parser lives in core/. */
const mermaidLang = StreamLanguage.define<{ header: boolean }>({
  startState: () => ({ header: false }),
  token(stream) {
    if (stream.sol() && stream.match(/^\s*%%.*/)) return "comment";
    if (stream.eatSpace()) return null;
    if (stream.match(/^(flowchart|graph)\b/)) return "keyword";
    if (stream.match(/^(TB|TD|BT|LR|RL)\b/)) return "keyword";
    if (
      stream.match(
        /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/,
      )
    )
      return "keyword";
    if (stream.match(/^<?(-{2,}|={2,}|-\.+-|~{3,})[>xo]?/)) return "operator";
    if (stream.match(/^\|[^|]*\|/)) return "string";
    if (stream.match(/^"[^"]*"/)) return "string";
    if (
      stream.match(/^(\(\(\(|\(\[|\[\[|\[\(|\(\(|\{\{|\[\/|\[\\|\(|\[|\{|>)/)
    ) {
      // label text up to the closing bracket
      stream.match(/^[^\])}]*/);
      return "string";
    }
    if (stream.match(/^[\])}\\/]+/)) return "string";
    if (stream.match(/^:::[\w-]+/)) return "meta";
    if (stream.match(/^&|;/)) return "operator";
    if (stream.match(/^[\p{L}\p{N}_-]+/u)) return "variableName";
    stream.next();
    return null;
  },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--kw)", fontWeight: "600" },
  { tag: t.operator, color: "var(--op)" },
  { tag: t.string, color: "var(--str)" },
  { tag: t.variableName, color: "var(--fg)" },
  { tag: t.meta, color: "var(--muted)" },
]);

export interface CodeEditorHandle {
  /** Applies UI patches as one transaction, so they land on the editor's undo stack. */
  apply(changes: Change[]): void;
  /** Replaces the whole document and clears history (used when opening a file). */
  reset(text: string): void;
}

interface Props {
  initial: string;
  errors: ParseError[];
  onChange(text: string): void;
}

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(
  function CodeEditor({ initial, errors, onChange }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const makeState = (doc: string) =>
      EditorState.create({
        doc,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          mermaidLang,
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      });

    useEffect(() => {
      view.current = new EditorView({
        state: makeState(initial),
        parent: host.current!,
      });
      return () => view.current?.destroy();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      const diagnostics: Diagnostic[] = errors.map((e) => ({
        from: Math.min(e.from, len),
        to: Math.min(Math.max(e.to, e.from), len),
        severity: "error",
        message: e.message,
      }));
      v.dispatch(setDiagnostics(v.state, diagnostics));
    }, [errors]);

    useImperativeHandle(ref, () => ({
      apply(changes) {
        if (changes.length)
          view.current?.dispatch({ changes, userEvent: "input.canvas" });
      },
      reset(text) {
        view.current?.setState(makeState(text));
        onChangeRef.current(text);
      },
    }));

    return <div className="editor" ref={host} />;
  },
);
