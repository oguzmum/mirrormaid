/** UML class box, relation markers and class-diagram menu items. */

import { memo, useContext, useEffect, useState } from "react";
import { Handle, type Node, type NodeProps } from "@xyflow/react";
import { CLASS_BOX } from "../core/autoLayout";
import {
  displayMember,
  relationArrow,
  type ClassNode,
  type Marker,
  type RelationType,
} from "../core/classDiagram";
import { editableName } from "../core/classPatches";
import { CanvasCtx, HANDLES, LabelInput } from "./canvasShared";

export interface MemberView {
  /** Index into the class's members, for editing. */
  index: number;
  raw: string;
  text: string;
  isStatic: boolean;
  isAbstract: boolean;
}

export type ClassData = {
  label: string;
  editName: string;
  annotation?: string;
  attributes: MemberView[];
  methods: MemberView[];
  w: number;
  h: number;
};

export function classData(n: ClassNode, w: number, h: number): ClassData {
  const views = n.members.map((m, index) => ({
    index,
    raw: m.text,
    ...displayMember(m.text),
  }));
  return {
    label: n.label,
    editName: editableName(n),
    annotation: n.annotation,
    attributes: views.filter((_, i) => n.members[i].kind === "attribute"),
    methods: views.filter((_, i) => n.members[i].kind === "method"),
    w,
    h,
  };
}

export const ClassNodeView = memo(function ClassNodeView({
  id,
  data,
  selected,
}: NodeProps<Node<ClassData>>) {
  const ctx = useContext(CanvasCtx);
  const [editing, setEditing] = useState<"name" | "add" | number>();
  const [target, source] = HANDLES[ctx.direction];
  const B = CLASS_BOX;

  useEffect(() => {
    if (ctx.autoEditId === id && !ctx.readOnly) {
      setEditing("name");
      ctx.onAutoEditDone();
    }
  }, [ctx, id]);

  const edit = (what: "name" | "add" | number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!ctx.readOnly) setEditing(what);
  };

  const row = (m: MemberView) =>
    editing === m.index ? (
      <div key={m.index} className="uml-row" style={{ height: B.row }}>
        <LabelInput
          className="uml-input"
          value={m.raw}
          onDone={(v) => {
            setEditing(undefined);
            if (v === null || v.trim() === m.raw) return;
            ctx.onMember(id, m.index, v.trim() || null);
          }}
        />
      </div>
    ) : (
      <div
        key={m.index}
        className={`uml-row${m.isStatic ? " static" : ""}${m.isAbstract ? " abstract" : ""}`}
        style={{ height: B.row }}
        title="Double-click to edit · empty to delete"
        onDoubleClick={edit(m.index)}
      >
        {m.text}
      </div>
    );

  return (
    <div
      className={`uml${selected ? " selected" : ""}`}
      style={{ width: data.w }}
      onDoubleClick={edit("add")}
    >
      <Handle type="target" position={target} />
      <div
        className="uml-head"
        style={{ height: B.header + (data.annotation ? B.annotation : 0) }}
        onDoubleClick={edit("name")}
      >
        {data.annotation && (
          <div className="uml-annotation">«{data.annotation}»</div>
        )}
        {editing === "name" ? (
          <LabelInput
            value={data.editName}
            onDone={(v) => {
              setEditing(undefined);
              if (v !== null && v.trim() && v.trim() !== data.editName)
                ctx.onRename(id, v.trim());
            }}
          />
        ) : (
          <div
            className={`uml-name${data.annotation === "abstract" ? " abstract" : ""}`}
          >
            {data.label}
          </div>
        )}
      </div>
      <div className="uml-section" style={{ padding: `${B.pad}px 0` }}>
        {data.attributes.map(row)}
      </div>
      <div className="uml-section" style={{ padding: `${B.pad}px 0` }}>
        {data.methods.map(row)}
        {editing === "add" && (
          <div className="uml-row" style={{ height: B.row }}>
            <LabelInput
              className="uml-input"
              value=""
              onDone={(v) => {
                setEditing(undefined);
                if (v?.trim()) ctx.onAddMember(id, v.trim());
              }}
            />
          </div>
        )}
      </div>
      {!ctx.readOnly && editing === undefined && (
        <button
          className="uml-add nodrag"
          title="Add member (or double-click the class)"
          onClick={edit("add")}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          +
        </button>
      )}
      <Handle type="source" position={source} />
    </div>
  );
});

// --- Relation markers ------------------------------------------------------------

export const markerId = (m: Marker) => `mm-${m}`;

/** SVG markers for UML relations. `auto-start-reverse` makes them work at both ends. */
export function UmlMarkerDefs() {
  const stroke = { stroke: "var(--edge)", strokeWidth: 1.3 };
  const hollow = { ...stroke, fill: "var(--node-fill)" };
  const filled = { ...stroke, fill: "var(--edge)" };
  const marker = (
    m: Marker,
    w: number,
    h: number,
    d: string,
    style: React.CSSProperties,
  ) => (
    <marker
      id={markerId(m)}
      viewBox={`0 0 ${w} ${h}`}
      refX={w - 1}
      refY={h / 2}
      markerWidth={w}
      markerHeight={h}
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d={d} style={style} />
    </marker>
  );
  return (
    <svg className="marker-defs" width="0" height="0" aria-hidden>
      <defs>
        {marker("triangle", 15, 14, "M1,1 L14,7 L1,13 Z", hollow)}
        {marker("diamond", 19, 10, "M1,5 L10,1 L18,5 L10,9 Z", filled)}
        {marker("diamond-open", 19, 10, "M1,5 L10,1 L18,5 L10,9 Z", hollow)}
        {marker("arrow", 12, 12, "M1,1 L11,6 L1,11", {
          ...stroke,
          fill: "none",
        })}
      </defs>
    </svg>
  );
}

// --- Menu items ----------------------------------------------------------------

const RELATIONS: { type: RelationType; name: string; marker?: Marker }[] = [
  { type: "association", name: "Association", marker: "arrow" },
  { type: "inheritance", name: "Inheritance", marker: "triangle" },
  { type: "realization", name: "Realization", marker: "triangle" },
  { type: "composition", name: "Composition", marker: "diamond" },
  { type: "aggregation", name: "Aggregation", marker: "diamond-open" },
  { type: "dependency", name: "Dependency", marker: "arrow" },
  { type: "link", name: "Link" },
  { type: "dashed-link", name: "Link (dashed)" },
];

export function RelationItems(props: {
  current?: RelationType;
  onPick(type: RelationType): void;
}) {
  return (
    <>
      {RELATIONS.map(({ type, name, marker }) => {
        const dashed = relationArrow(type, "right").includes("..");
        return (
          <button
            key={type}
            role="menuitemradio"
            aria-checked={type === props.current}
            className={`context-menu-item${type === props.current ? " active" : ""}`}
            onClick={() => props.onPick(type)}
          >
            <svg className="relation-icon" width="34" height="14">
              <line
                x1="2"
                y1="7"
                x2="32"
                y2="7"
                strokeDasharray={dashed ? "3 3" : undefined}
                markerEnd={marker ? `url(#${markerId(marker)})` : undefined}
              />
            </svg>
            <span className="context-menu-name">{name}</span>
            <code>{relationArrow(type, "right")}</code>
          </button>
        );
      })}
    </>
  );
}

const ANNOTATIONS = ["interface", "abstract", "enumeration", "service"];

export function AnnotationItems(props: {
  current?: string;
  onPick(annotation: string | undefined): void;
}) {
  const items = [undefined, ...ANNOTATIONS];
  return (
    <>
      {items.map((a) => (
        <button
          key={a ?? "none"}
          role="menuitemradio"
          aria-checked={a === props.current}
          className={`context-menu-item${a === props.current ? " active" : ""}`}
          onClick={() => props.onPick(a)}
        >
          <span className="context-menu-name">
            {a ? `«${a}»` : "No annotation"}
          </span>
        </button>
      ))}
    </>
  );
}
