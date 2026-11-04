/** Mindmap node (seven Mermaid shapes, colored by branch), its edge and menu items. */

import { memo, useContext, useEffect, useState } from "react";
import {
  BaseEdge,
  Handle,
  Position,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { MindmapNode, MindmapShape } from "../core/mindmap";
import { CanvasCtx, LabelInput, displayLabel } from "./canvasShared";

/** Branch colors cycle through this many CSS variables (`--mm-0` ...). */
const BRANCH_COLORS = 8;

export const branchColor = (branch: number) =>
  branch < 0 ? "var(--accent)" : `var(--mm-${branch % BRANCH_COLORS})`;

export type MindmapData = {
  label: string;
  shape: MindmapShape;
  depth: number;
  branch: number;
  w: number;
  h: number;
};

export function mindmapData(n: MindmapNode, w: number, h: number): MindmapData {
  return {
    label: n.label,
    shape: n.shape,
    depth: n.depth,
    branch: n.branch,
    w,
    h,
  };
}

/** Points on an ellipse, starting at the top, clockwise. */
function ring(w: number, h: number, n: number, scale = 1) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    return {
      x: w / 2 + Math.cos(a) * (w / 2) * scale,
      y: h / 2 + Math.sin(a) * (h / 2) * scale,
    };
  });
}

/** Outline for the shapes that aren't plain CSS boxes. */
export function MindmapOutline(props: {
  shape: MindmapShape;
  w: number;
  h: number;
}) {
  const { shape, w, h } = props;
  let el: React.ReactNode;
  switch (shape) {
    case "circle":
      el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />;
      break;
    case "hexagon": {
      const s = Math.min(14, w / 5);
      el = (
        <polygon
          points={`${s},0 ${w - s},0 ${w},${h / 2} ${w - s},${h} ${s},${h} 0,${h / 2}`}
        />
      );
      break;
    }
    case "bang": {
      // Alternating outer and inner points make a burst.
      const pts = ring(w, h, 24).map((p, i) =>
        i % 2
          ? { x: w / 2 + (p.x - w / 2) * 0.78, y: h / 2 + (p.y - h / 2) * 0.78 }
          : p,
      );
      el = <polygon points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />;
      break;
    }
    case "cloud": {
      // Arcs between points on a smaller ellipse bulge outwards.
      const pts = ring(w, h, 10, 0.86);
      const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * 0.62;
      const d =
        `M${pts[0].x},${pts[0].y}` +
        pts
          .map((_, i) => {
            const q = pts[(i + 1) % pts.length];
            return ` A${r},${r} 0 0 1 ${q.x},${q.y}`;
          })
          .join("") +
        " Z";
      el = <path d={d} />;
      break;
    }
    default:
      return null;
  }
  return (
    <svg className="shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {el}
    </svg>
  );
}

export const MindmapNodeView = memo(function MindmapNodeView({
  id,
  data,
  selected,
}: NodeProps<Node<MindmapData>>) {
  const ctx = useContext(CanvasCtx);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (ctx.autoEditId === id && !ctx.readOnly) {
      setEditing(true);
      ctx.onAutoEditDone();
    }
  }, [ctx, id]);

  return (
    <div
      className={`node mm mm-${data.shape}${data.depth === 0 ? " mm-root" : ""}${selected ? " selected" : ""}`}
      style={
        {
          width: data.w,
          height: data.h,
          "--branch": branchColor(data.branch),
        } as React.CSSProperties
      }
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!ctx.readOnly) setEditing(true);
      }}
    >
      <MindmapOutline shape={data.shape} w={data.w} h={data.h} />
      {/* Edges find their own sides; the handles only have to exist. */}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {editing ? (
        <LabelInput
          value={data.label}
          onDone={(v) => {
            setEditing(false);
            if (v !== null && v.trim() && v.trim() !== data.label)
              ctx.onRename(id, v.trim());
          }}
        />
      ) : (
        <span className="node-label">{displayLabel(data.label)}</span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

// --- Edge ----------------------------------------------------------------------

export type MindmapEdgeData = { branch: number; depth: number };

function rectOf(n: InternalNode | undefined) {
  const w = n?.measured.width;
  const h = n?.measured.height;
  if (!n || !w || !h) return undefined;
  const { x, y } = n.internals.positionAbsolute;
  return { x, y, w, h };
}

/**
 * A curve from the parent's side to the child's facing side. Which side
 * depends on where the child is, so branches can grow left or right.
 */
export const MindmapEdgeView = memo(function MindmapEdgeView(
  p: EdgeProps<Edge<MindmapEdgeData>>,
) {
  const a = rectOf(useInternalNode(p.source));
  const b = rectOf(useInternalNode(p.target));
  if (!a || !b) return null;
  const right = b.x + b.w / 2 >= a.x + a.w / 2;
  const sx = right ? a.x + a.w : a.x;
  const sy = a.y + a.h / 2;
  const tx = right ? b.x : b.x + b.w;
  const ty = b.y + b.h / 2;
  const mx = (sx + tx) / 2;
  const { branch, depth } = p.data!;
  return (
    <BaseEdge
      path={`M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`}
      style={{
        stroke: branchColor(branch),
        strokeWidth: Math.max(1.5, 4 - depth),
        strokeLinecap: "round",
      }}
    />
  );
});

// --- Menu items ----------------------------------------------------------------

const SHAPES: { shape: MindmapShape; name: string; code: string }[] = [
  { shape: "default", name: "Default", code: "Text" },
  { shape: "square", name: "Square", code: "[…]" },
  { shape: "rounded", name: "Rounded", code: "(…)" },
  { shape: "circle", name: "Circle", code: "((…))" },
  { shape: "bang", name: "Bang", code: "))…((" },
  { shape: "cloud", name: "Cloud", code: ")…(" },
  { shape: "hexagon", name: "Hexagon", code: "{{…}}" },
];

export function MindmapShapeItems(props: {
  current?: MindmapShape;
  onPick(shape: MindmapShape): void;
}) {
  return (
    <>
      {SHAPES.map(({ shape, name, code }) => (
        <button
          key={shape}
          role="menuitemradio"
          aria-checked={shape === props.current}
          className={`context-menu-item${shape === props.current ? " active" : ""}`}
          onClick={() => props.onPick(shape)}
        >
          <span className={`mm-icon mm mm-${shape}`}>
            <MindmapOutline shape={shape} w={26} h={16} />
          </span>
          <span className="context-menu-name">{name}</span>
          <code>{code}</code>
        </button>
      ))}
    </>
  );
}
