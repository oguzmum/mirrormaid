/** State node (rounded box, start/end dots, choice diamond, fork/join bar) and its menu items. */

import { memo, useContext, useEffect, useState } from "react";
import { Handle, type Node, type NodeProps } from "@xyflow/react";
import type { Shape } from "../core/flowchart";
import type { StateKind, StateNode } from "../core/stateDiagram";
import { editableStateName } from "../core/statePatches";
import { CanvasCtx, HANDLES, LabelInput, displayLabel } from "./canvasShared";

export type StateData = {
  kind: StateKind;
  label: string;
  editName: string;
  /** Outline used for routed edges to find the border. */
  shape: Shape;
  w: number;
  h: number;
};

export function stateData(n: StateNode, w: number, h: number): StateData {
  return {
    kind: n.kind,
    label: n.label,
    editName: editableStateName(n),
    shape:
      n.kind === "start" || n.kind === "end"
        ? "circle"
        : n.kind === "choice"
          ? "diamond"
          : "rect",
    w,
    h,
  };
}

export const StateNodeView = memo(function StateNodeView({
  id,
  data,
  selected,
}: NodeProps<Node<StateData>>) {
  const ctx = useContext(CanvasCtx);
  const [editing, setEditing] = useState(false);
  const [target, source] = HANDLES[ctx.direction];
  const editable = data.kind === "state";

  useEffect(() => {
    if (ctx.autoEditId === id && !ctx.readOnly && editable) {
      setEditing(true);
      ctx.onAutoEditDone();
    }
  }, [ctx, id, editable]);

  let body: React.ReactNode = null;
  if (data.kind === "choice") {
    const { w, h } = data;
    body = (
      <svg className="shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
      </svg>
    );
  } else if (data.kind === "end") {
    body = <span className="state-end-dot" />;
  } else if (data.kind === "state") {
    body = editing ? (
      <LabelInput
        value={data.editName}
        onDone={(v) => {
          setEditing(false);
          if (v !== null && v.trim() && v.trim() !== data.editName)
            ctx.onRename(id, v.trim());
        }}
      />
    ) : (
      <span className="node-label">{displayLabel(data.label)}</span>
    );
  }

  return (
    <div
      className={`node state state-${data.kind}${selected ? " selected" : ""}`}
      style={{ width: data.w, height: data.h }}
      title={
        data.kind === "start"
          ? "Start"
          : data.kind === "end"
            ? "End"
            : editable
              ? undefined
              : data.label
      }
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!ctx.readOnly && editable) setEditing(true);
      }}
    >
      <Handle type="target" position={target} />
      {body}
      <Handle type="source" position={source} />
    </div>
  );
});

// --- Menu items ----------------------------------------------------------------

const KINDS: {
  kind: Exclude<StateKind, "start" | "end">;
  name: string;
  code: string;
}[] = [
  { kind: "state", name: "State", code: "Name" },
  { kind: "choice", name: "Choice", code: "<<choice>>" },
  { kind: "fork", name: "Fork", code: "<<fork>>" },
  { kind: "join", name: "Join", code: "<<join>>" },
];

export function StateKindItems(props: {
  current?: StateKind;
  onPick(kind: Exclude<StateKind, "start" | "end">): void;
}) {
  return (
    <>
      {KINDS.map(({ kind, name, code }) => (
        <button
          key={kind}
          role="menuitemradio"
          aria-checked={kind === props.current}
          className={`context-menu-item${kind === props.current ? " active" : ""}`}
          onClick={() => props.onPick(kind)}
        >
          <span className={`state-icon state-icon-${kind}`} />
          <span className="context-menu-name">{name}</span>
          <code>{code}</code>
        </button>
      ))}
    </>
  );
}
