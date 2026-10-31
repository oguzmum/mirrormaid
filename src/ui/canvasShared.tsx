/** Pieces shared by the canvas and its node/edge components. */

import { createContext, useEffect, useRef, useState } from "react";
import { Position } from "@xyflow/react";
import type { Direction } from "../core/flowchart";
import type { Pos } from "../core/layoutBlock";

export interface Ctx {
  direction: Direction;
  readOnly: boolean;
  autoEditId?: string;
  editingEdge?: string;
  setEditingEdge(id?: string): void;
  onRename(id: string, label: string): void;
  /** Replaces a class member's text, or deletes it when `text` is null. */
  onMember(id: string, index: number, text: string | null): void;
  onAddMember(id: string, text: string): void;
  onEdgeLabel(edgeId: string, label: string): void;
  onRoute(edgeId: string, points: Pos[]): void;
  toFlow(clientX: number, clientY: number): Pos;
  onAutoEditDone(): void;
}
export const CanvasCtx = createContext<Ctx>(null!);

export const HANDLES: Record<Direction, [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
};

export function displayLabel(label: string) {
  return label.replace(/<br\s*\/?>/gi, "\n");
}

// --- Inline label editor -------------------------------------------------------

export function LabelInput(props: {
  value: string;
  onDone(value: string | null): void;
  className?: string;
}) {
  const [value, setValue] = useState(props.value);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    // New nodes are hidden until React Flow has measured them, and hidden inputs
    // can't take focus, so retry for a few frames.
    let tries = 0;
    let raf = 0;
    const focus = () => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      if (document.activeElement === el) el.select();
      else if (tries++ < 10) raf = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(raf);
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(v);
  };
  return (
    <input
      ref={ref}
      className={`label-input nodrag nopan ${props.className ?? ""}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
}
