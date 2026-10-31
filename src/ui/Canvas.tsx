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
  useInternalNode,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type InternalNode,
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
import {
  routeKeys,
  type Layout,
  type Pos,
  type Routes,
} from "../core/layoutBlock";
import { nodeSize } from "../core/autoLayout";

export interface CanvasProps {
  fc: Flowchart;
  layout: Layout;
  routes: Routes;
  readOnly: boolean;
  /** Node that should open its label editor as soon as it appears. */
  autoEditId?: string;
  /** Bump to trigger fitView. */
  fitSignal: number;
  onMove(positions: Layout): void;
  onRename(id: string, label: string): void;
  onChangeShape(id: string, shape: Shape): void;
  /** Sets an edge's waypoints; an empty list resets it to the automatic curve. */
  onRoute(edgeId: string, points: Pos[]): void;
  onEdgeLabel(edgeId: string, label: string): void;
  onConnect(from: string, to: string): void;
  onAddNode(pos: Pos): void;
  onDelete(nodeIds: string[], edgeIds: string[]): void;
  onAutoEditDone(): void;
}

type ShapeData = { label: string; shape: Shape; w: number; h: number };
type EdgeData = { label?: string; link: Link; points?: Pos[] };

interface Ctx {
  direction: Direction;
  readOnly: boolean;
  autoEditId?: string;
  editingEdge?: string;
  setEditingEdge(id?: string): void;
  onRename(id: string, label: string): void;
  onEdgeLabel(edgeId: string, label: string): void;
  onRoute(edgeId: string, points: Pos[]): void;
  toFlow(clientX: number, clientY: number): Pos;
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
  const { fc, layout, routes, readOnly } = props;
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node<ShapeData>[]>([]);
  const [edges, setEdges] = useState<Edge<EdgeData>[]>([]);
  const [editingEdge, setEditingEdge] = useState<string>();
  const [menu, setMenu] = useState<{
    kind: "node" | "edge";
    id: string;
    x: number;
    y: number;
  }>();

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
      const keys = routeKeys(fc);
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
          data: { label: link.label, link, points: routes[keys.get(e.id)!] },
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
  }, [fc, layout, routes]);

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
    onRoute: props.onRoute,
    toFlow: (x, y) => rf.screenToFlowPosition({ x, y }),
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
            setMenu({ kind: "node", id: n.id, x: e.clientX, y: e.clientY });
          }}
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault();
            if (readOnly) return;
            setMenu({ kind: "edge", id: edge.id, x: e.clientX, y: e.clientY });
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
        {menu?.kind === "node" && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            title="Change type"
            onClose={() => setMenu(undefined)}
          >
            <ShapeItems
              current={fc.nodes.find((n) => n.id === menu.id)?.shape}
              onPick={(shape) => {
                setMenu(undefined);
                props.onChangeShape(menu.id, shape);
              }}
            />
          </ContextMenu>
        )}
        {menu?.kind === "edge" && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            title="Edge"
            onClose={() => setMenu(undefined)}
          >
            <button
              role="menuitem"
              className="context-menu-item"
              disabled={!edges.find((e) => e.id === menu.id)?.data?.points}
              onClick={() => {
                setMenu(undefined);
                props.onRoute(menu.id, []);
              }}
            >
              <span className="context-menu-name">Reset route</span>
            </button>
          </ContextMenu>
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

function ContextMenu(props: {
  x: number;
  y: number;
  title: string;
  onClose(): void;
  children: React.ReactNode;
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
      <div className="context-menu-title">{props.title}</div>
      {props.children}
    </div>
  );
}

function ShapeItems(props: { current?: Shape; onPick(shape: Shape): void }) {
  return (
    <>
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
    </>
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

/** Polyline through the points with rounded corners. */
function roundedPath(pts: Pos[], radius: number): string {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) {
      d += ` L${p1.x},${p1.y}`;
      continue;
    }
    const ax = p1.x + ((p0.x - p1.x) * r) / d1;
    const ay = p1.y + ((p0.y - p1.y) * r) / d1;
    const bx = p1.x + ((p2.x - p1.x) * r) / d2;
    const by = p1.y + ((p2.y - p1.y) * r) / d2;
    d += ` L${ax},${ay} Q${p1.x},${p1.y} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L${last.x},${last.y}`;
}

/** The point halfway along the polyline, where the label goes. */
function polylineMidpoint(pts: Pos[]): Pos {
  const lens = pts
    .slice(1)
    .map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  let rest = lens.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lens.length; i++) {
    if (rest <= lens[i] && lens[i] > 0) {
      const t = rest / lens[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    rest -= lens[i];
  }
  return pts[0];
}

function distToSegment(p: Pos, a: Pos, b: Pos): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Snaps x/y to a neighbouring point when close, so straight lines are easy. */
function snapTo(p: Pos, neighbours: Pos[], dist = 8): Pos {
  let { x, y } = p;
  for (const n of neighbours) {
    if (Math.abs(n.x - p.x) < dist) x = n.x;
    if (Math.abs(n.y - p.y) < dist) y = n.y;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/** Center of a node, or the fallback while it isn't measured yet. */
function centerOf(node: InternalNode | undefined, fallback: Pos): Pos {
  const w = node?.measured.width;
  const h = node?.measured.height;
  if (!node || !w || !h) return fallback;
  const { x, y } = node.internals.positionAbsolute;
  return { x: x + w / 2, y: y + h / 2 };
}

/** Where the line from the node's center towards `toward` leaves its outline. */
function borderPoint(
  node: InternalNode | undefined,
  toward: Pos,
  fallback: Pos,
): Pos {
  const w = node?.measured.width;
  const h = node?.measured.height;
  if (!node || !w || !h) return fallback;
  const c = centerOf(node, fallback);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const [rx, ry] = [w / 2, h / 2];
  const shape = (node.data as ShapeData).shape;
  let t: number;
  if (shape === "diamond") t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  else if (shape === "circle" || shape === "double-circle")
    t = 1 / Math.hypot(dx / rx, dy / ry);
  else
    t = Math.min(
      dx ? rx / Math.abs(dx) : Infinity,
      dy ? ry / Math.abs(dy) : Infinity,
    );
  t = Math.min(t, 1);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

const LabelEdge = memo(function LabelEdge(p: EdgeProps<Edge<EdgeData>>) {
  const ctx = useContext(CanvasCtx);
  const link = p.data!.link;
  const editing = ctx.editingEdge === p.id;
  /** Live waypoints while dragging; committed on pointer up. */
  const [draft, setDraft] = useState<Pos[] | null>(null);
  const points = draft ?? p.data!.points ?? [];
  const sourceNode = useInternalNode(p.source);
  const targetNode = useInternalNode(p.target);
  // Routed edges float: they leave the node's outline towards the first/last
  // waypoint instead of the fixed handle, so they can go in any direction.
  const src = points.length
    ? borderPoint(sourceNode, points[0], { x: p.sourceX, y: p.sourceY })
    : { x: p.sourceX, y: p.sourceY };
  const tgt = points.length
    ? borderPoint(targetNode, points[points.length - 1], {
        x: p.targetX,
        y: p.targetY,
      })
    : { x: p.targetX, y: p.targetY };
  const all = [src, ...points, tgt];
  // The first/last waypoint snaps to the node centers, so lines can be made straight.
  const srcCenter = centerOf(sourceNode, src);
  const tgtCenter = centerOf(targetNode, tgt);

  let path: string;
  let mid: Pos;
  if (points.length) {
    path = roundedPath(all, 10);
    mid = polylineMidpoint(all);
  } else {
    const [d, lx, ly] = getBezierPath(p);
    path = d;
    mid = { x: lx, y: ly };
  }

  const canEdit = !ctx.readOnly;

  /**
   * Drags waypoint `index`. With `insert`, a new waypoint is created there
   * first, but only kept if the pointer actually moves (a click just selects).
   */
  const startDrag = (e: React.PointerEvent, index: number, insert: boolean) => {
    if (!canEdit || e.button !== 0) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY };
    const base = [...points];
    if (insert) base.splice(index, 0, ctx.toFlow(e.clientX, e.clientY));
    let current = base;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3)
        return;
      moved = true;
      const full = [srcCenter, ...base, tgtCenter];
      const pt = snapTo(ctx.toFlow(ev.clientX, ev.clientY), [
        full[index],
        full[index + 2],
      ]);
      current = base.map((q, i) => (i === index ? pt : q));
      setDraft(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) ctx.onRoute(p.id, current);
      setDraft(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** Grabbing the line itself bends it at the nearest segment. */
  const grabLine = (e: React.PointerEvent) => {
    const at = ctx.toFlow(e.clientX, e.clientY);
    let seg = 0;
    if (points.length) {
      let best = Infinity;
      for (let i = 0; i < all.length - 1; i++) {
        const d = distToSegment(at, all[i], all[i + 1]);
        if (d < best) [best, seg] = [d, i];
      }
    }
    startDrag(e, seg, true);
  };

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

  const showHandles = p.selected && canEdit && !editing;
  // Spots that add a bend when dragged: segment middles, or the curve's middle
  // (unless the label sits there; the line itself can be grabbed, too).
  const midpoints = points.length
    ? all.slice(1).map((q, i) => ({
        x: (all[i].x + q.x) / 2,
        y: (all[i].y + q.y) / 2,
      }))
    : p.data!.label
      ? []
      : [mid];

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={p.markerEnd}
        markerStart={p.markerStart}
        style={style}
      />
      {canEdit && (
        <path d={path} className="edge-grab nopan" onPointerDown={grabLine} />
      )}
      {(p.data!.label || editing || showHandles) && (
        <EdgeLabelRenderer>
          {(p.data!.label || editing) && (
            <div
              className={`edge-label nodrag nopan${p.selected ? " selected" : ""}`}
              style={{
                transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
              }}
              onDoubleClick={() => canEdit && ctx.setEditingEdge(p.id)}
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
          )}
          {showHandles &&
            points.map((q, i) => (
              <div
                key={`p${i}`}
                className="edge-handle nodrag nopan"
                title="Drag to move · double-click to remove"
                style={{ transform: `translate(${q.x}px, ${q.y}px)` }}
                onPointerDown={(e) => startDrag(e, i, false)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  ctx.onRoute(
                    p.id,
                    points.filter((_, j) => j !== i),
                  );
                }}
              />
            ))}
          {showHandles &&
            !draft &&
            midpoints.map((q, i) => (
              <div
                key={`m${i}`}
                className="edge-handle add nodrag nopan"
                title="Drag to add a bend"
                style={{ transform: `translate(${q.x}px, ${q.y}px)` }}
                onPointerDown={(e) => startDrag(e, i, true)}
              />
            ))}
        </EdgeLabelRenderer>
      )}
    </>
  );
});

const nodeTypes = { shape: ShapeNode };
const edgeTypes = { label: LabelEdge };
