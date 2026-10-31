import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  SHAPE_DELIMS,
  type Direction,
  type Flowchart,
  type Link,
  type Shape,
} from "../core/flowchart";
import type { Layout, Pos } from "../core/layoutBlock";
import { nodeSize } from "../core/autoLayout";

export interface CanvasProps {
  fc: Flowchart;
  layout: Layout;
  readOnly: boolean;
  /** Node that should open its label editor as soon as it appears. */
  autoEditId?: string;
  /** Bump to trigger fitView. */
  fitSignal: number;
  onMove(positions: Layout): void;
  onRename(id: string, label: string): void;
  onChangeShape(id: string, shape: Shape): void;
  onEdgeLabel(edgeId: string, label: string): void;
  onConnect(from: string, to: string): void;
  onAddNode(pos: Pos): void;
  onDelete(nodeIds: string[], edgeIds: string[]): void;
  onAutoEditDone(): void;
}

type ShapeData = { label: string; shape: Shape; w: number; h: number };
type EdgeData = { label?: string; link: Link };

interface Ctx {
  direction: Direction;
  readOnly: boolean;
  autoEditId?: string;
  editingEdge?: string;
  setEditingEdge(id?: string): void;
  onRename(id: string, label: string): void;
  onEdgeLabel(edgeId: string, label: string): void;
  onAutoEditDone(): void;
}
const CanvasCtx = createContext<Ctx>(null!);

const HANDLES: Record<Direction, [Position, Position]> = {
  LR: [Position.Left, Position.Right],
  RL: [Position.Right, Position.Left],
  TB: [Position.Top, Position.Bottom],
  BT: [Position.Bottom, Position.Top],
};

function displayLabel(label: string) {
  return label.replace(/<br\s*\/?>/gi, "\n");
}

export function Canvas(props: CanvasProps) {
  const { fc, layout, readOnly } = props;
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node<ShapeData>[]>([]);
  const [edges, setEdges] = useState<Edge<EdgeData>[]>([]);
  const [editingEdge, setEditingEdge] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();

  // Derive React Flow state from the parsed text + layout, keeping the selection.
  useEffect(() => {
    setNodes((prev) => {
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return fc.nodes.map((n) => {
        const size = nodeSize(n);
        return {
          id: n.id,
          type: "shape",
          position: layout[n.id] ?? { x: 0, y: 0 },
          data: { label: n.label, shape: n.shape, w: size.w, h: size.h },
          selected: selected.has(n.id),
        };
      });
    });
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return fc.edges.map((e) => {
        const link = fc.statements[e.statement].links[e.link];
        const marker =
          link.head === "none"
            ? undefined
            : link.head === "arrow"
              ? MarkerType.ArrowClosed
              : MarkerType.Arrow;
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "label",
          data: { label: link.label, link },
          selected: selected.has(e.id),
          markerEnd: marker && {
            type: marker,
            width: 16,
            height: 16,
            color: "var(--edge)",
          },
          markerStart: link.tailArrow
            ? {
                type: MarkerType.ArrowClosed,
                width: 16,
                height: 16,
                color: "var(--edge)",
              }
            : undefined,
        };
      });
    });
  }, [fc, layout]);

  const firstFit = useRef(true);
  useEffect(() => {
    if (firstFit.current) {
      firstFit.current = false;
      return;
    }
    // Wait a frame so freshly derived nodes are measured.
    requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 200 }));
  }, [props.fitSignal, rf]);

  const ctx: Ctx = {
    direction: fc.direction,
    readOnly,
    autoEditId: props.autoEditId,
    editingEdge,
    setEditingEdge,
    onRename: props.onRename,
    onEdgeLabel: props.onEdgeLabel,
    onAutoEditDone: props.onAutoEditDone,
  };

  return (
    <CanvasCtx.Provider value={ctx}>
      <div
        className={`canvas${readOnly ? " readonly" : ""}`}
        onDoubleClick={(e) => {
          if (
            readOnly ||
            !(e.target as HTMLElement).classList.contains("react-flow__pane")
          )
            return;
          const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          const s = nodeSize({ label: "New node", shape: "rect" });
          props.onAddNode({
            x: Math.round(p.x - s.w / 2),
            y: Math.round(p.y - s.h / 2),
          });
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(c) => setNodes((ns) => applyNodeChanges(c, ns))}
          onEdgesChange={(c) => setEdges((es) => applyEdgeChanges(c, es))}
          onNodeDragStop={(_, __, dragged) => {
            const moved: Layout = {};
            for (const n of dragged)
              moved[n.id] = {
                x: Math.round(n.position.x),
                y: Math.round(n.position.y),
              };
            props.onMove(moved);
          }}
          onConnect={(c) =>
            c.source && c.target && props.onConnect(c.source, c.target)
          }
          onDelete={({ nodes: ns, edges: es }) =>
            props.onDelete(
              ns.map((n) => n.id),
              es.map((e) => e.id),
            )
          }
          onNodeContextMenu={(e, n) => {
            e.preventDefault();
            if (readOnly) return;
            setMenu({ id: n.id, x: e.clientX, y: e.clientY });
          }}
          onPaneClick={() => setMenu(undefined)}
          onMoveStart={() => setMenu(undefined)}
          onEdgeDoubleClick={(_, e) => !readOnly && setEditingEdge(e.id)}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          connectionMode={ConnectionMode.Loose}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {menu && (
          <ShapeMenu
            x={menu.x}
            y={menu.y}
            current={fc.nodes.find((n) => n.id === menu.id)?.shape}
            onPick={(shape) => {
              setMenu(undefined);
              props.onChangeShape(menu.id, shape);
            }}
            onClose={() => setMenu(undefined)}
          />
        )}
      </div>
    </CanvasCtx.Provider>
  );
}

// --- Shape context menu --------------------------------------------------------

const SHAPE_OPTIONS: { shape: Shape; name: string }[] = [
  { shape: "rect", name: "Rectangle" },
  { shape: "round", name: "Rounded" },
  { shape: "stadium", name: "Stadium" },
  { shape: "subroutine", name: "Subroutine" },
  { shape: "cylinder", name: "Database" },
  { shape: "circle", name: "Circle" },
  { shape: "double-circle", name: "Double circle" },
  { shape: "asymmetric", name: "Asymmetric" },
  { shape: "diamond", name: "Decision" },
  { shape: "hexagon", name: "Hexagon" },
  { shape: "parallelogram", name: "Parallelogram" },
  { shape: "parallelogram-alt", name: "Parallelogram (alt)" },
  { shape: "trapezoid", name: "Trapezoid" },
  { shape: "trapezoid-alt", name: "Trapezoid (alt)" },
];

function ShapeMenu(props: {
  x: number;
  y: number;
  current?: Shape;
  onPick(shape: Shape): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  // Keep the menu inside the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(props.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(props.y, window.innerHeight - r.height - 8)),
    });
  }, [props.x, props.y]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node_)) props.onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", props.onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", props.onClose);
    };
  }, [props.onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={pos}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="context-menu-title">Change type</div>
      {SHAPE_OPTIONS.map(({ shape, name }) => {
        const [open, close] = SHAPE_DELIMS[shape];
        return (
          <button
            key={shape}
            role="menuitemradio"
            aria-checked={shape === props.current}
            className={`context-menu-item${shape === props.current ? " active" : ""}`}
            onClick={() => props.onPick(shape)}
          >
            <span className="shape-icon">
              <ShapeOutline shape={shape} w={26} h={16} />
            </span>
            <span className="context-menu-name">{name}</span>
            <code>
              {open}…{close}
            </code>
          </button>
        );
      })}
    </div>
  );
}

type Node_ = globalThis.Node;

// --- Inline label editor -------------------------------------------------------

function LabelInput(props: {
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

// --- Nodes ---------------------------------------------------------------------

function ShapeOutline({ shape, w, h }: { shape: Shape; w: number; h: number }) {
  const s = Math.min(8, w / 6); // slant / inset (smaller for menu icons)
  let el: React.ReactNode;
  switch (shape) {
    case "round":
      el = <rect width={w} height={h} rx={10} />;
      break;
    case "stadium":
      el = <rect width={w} height={h} rx={h / 2} />;
      break;
    case "subroutine":
      el = (
        <>
          <rect width={w} height={h} />
          <line x1={s} y1={0} x2={s} y2={h} />
          <line x1={w - s} y1={0} x2={w - s} y2={h} />
        </>
      );
      break;
    case "cylinder": {
      const ry = Math.min(10, h / 5);
      el = (
        <>
          <path
            d={`M0,${ry} a${w / 2},${ry} 0 0 0 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0 1 ${-w},0 Z`}
          />
          <ellipse cx={w / 2} cy={ry} rx={w / 2} ry={ry} />
        </>
      );
      break;
    }
    case "circle":
      el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />;
      break;
    case "double-circle":
      el = (
        <>
          <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} />
          <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 5} ry={h / 2 - 5} />
        </>
      );
      break;
    case "asymmetric":
      el = (
        <polygon points={`0,0 ${w},0 ${w},${h} 0,${h} ${s * 1.5},${h / 2}`} />
      );
      break;
    case "diamond":
      el = (
        <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} />
      );
      break;
    case "hexagon":
      el = (
        <polygon
          points={`${s * 1.5},0 ${w - s * 1.5},0 ${w},${h / 2} ${w - s * 1.5},${h} ${s * 1.5},${h} 0,${h / 2}`}
        />
      );
      break;
    case "parallelogram":
      el = (
        <polygon points={`${s * 1.5},0 ${w},0 ${w - s * 1.5},${h} 0,${h}`} />
      );
      break;
    case "parallelogram-alt":
      el = (
        <polygon points={`0,0 ${w - s * 1.5},0 ${w},${h} ${s * 1.5},${h}`} />
      );
      break;
    case "trapezoid":
      el = (
        <polygon points={`${s * 1.5},0 ${w - s * 1.5},0 ${w},${h} 0,${h}`} />
      );
      break;
    case "trapezoid-alt":
      el = (
        <polygon points={`0,0 ${w},0 ${w - s * 1.5},${h} ${s * 1.5},${h}`} />
      );
      break;
    default:
      el = <rect width={w} height={h} rx={6} />;
  }
  return (
    <svg className="shape" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {el}
    </svg>
  );
}

const ShapeNode = memo(function ShapeNode({
  id,
  data,
  selected,
}: NodeProps<Node<ShapeData>>) {
  const ctx = useContext(CanvasCtx);
  const [editing, setEditing] = useState(false);
  const [target, source] = HANDLES[ctx.direction];

  useEffect(() => {
    if (ctx.autoEditId === id && !ctx.readOnly) {
      setEditing(true);
      ctx.onAutoEditDone();
    }
  }, [ctx, id]);

  return (
    <div
      className={`node${selected ? " selected" : ""}`}
      style={{ width: data.w, height: data.h }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!ctx.readOnly) setEditing(true);
      }}
    >
      <ShapeOutline shape={data.shape} w={data.w} h={data.h} />
      <Handle type="target" position={target} />
      {editing ? (
        <LabelInput
          value={data.label}
          onDone={(v) => {
            setEditing(false);
            if (v !== null && v.trim() && v !== data.label)
              ctx.onRename(id, v.trim());
          }}
        />
      ) : (
        <span className="node-label">{displayLabel(data.label)}</span>
      )}
      <Handle type="source" position={source} />
    </div>
  );
});

// --- Edges ---------------------------------------------------------------------

const LabelEdge = memo(function LabelEdge(p: EdgeProps<Edge<EdgeData>>) {
  const ctx = useContext(CanvasCtx);
  const [path, lx, ly] = getBezierPath(p);
  const link = p.data!.link;
  const editing = ctx.editingEdge === p.id;
  const style: React.CSSProperties = {
    stroke: "var(--edge)",
    strokeWidth: link.style === "thick" ? 3 : 1.5,
    strokeDasharray:
      link.style === "dotted"
        ? "4 4"
        : link.style === "invisible"
          ? "2 6"
          : undefined,
    opacity: link.style === "invisible" ? 0.35 : 1,
  };
  if (p.selected) style.stroke = "var(--accent)";

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={p.markerEnd}
        markerStart={p.markerStart}
        style={style}
      />
      {(p.data!.label || editing) && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label nodrag nopan${p.selected ? " selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`,
            }}
            onDoubleClick={() => !ctx.readOnly && ctx.setEditingEdge(p.id)}
          >
            {editing ? (
              <LabelInput
                className="edge"
                value={p.data!.label ?? ""}
                onDone={(v) => {
                  ctx.setEditingEdge(undefined);
                  if (v !== null && v.trim() !== (p.data!.label ?? ""))
                    ctx.onEdgeLabel(p.id, v);
                }}
              />
            ) : (
              displayLabel(p.data!.label!)
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { shape: ShapeNode };
const edgeTypes = { label: LabelEdge };
