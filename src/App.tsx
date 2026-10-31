import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { parseFlowchart, type Flowchart, type Shape } from "./core/flowchart";
import {
  joinFile,
  routeKeys,
  splitFile,
  type Layout,
  type Pos,
  type Routes,
} from "./core/layoutBlock";
import {
  addEdge,
  addNode,
  deleteElements,
  nextNodeId,
  renameNode,
  changeNodeShape,
  setEdgeLabel,
  type Change,
} from "./core/patches";
import { autoLayoutAll, placeMissing } from "./core/autoLayout";
import { CodeEditor, type CodeEditorHandle } from "./ui/CodeEditor";
import { Canvas } from "./ui/Canvas";
import {
  WriteNotAllowedError,
  canWriteFiles,
  download,
  openFile,
  saveFileAs,
  writeFile,
} from "./ui/fileIO";
import {
  ensurePermission,
  lastDenied,
  recallHandle,
  rememberHandle,
} from "./ui/fileStore";
import { useMermaidCheck } from "./ui/useMermaidCheck";

const SAMPLE = `flowchart LR
    A[Idea] --> B{Worth it?}
    B -->|yes| C([Build it])
    B -->|no| D[Sketch more]
    D --> A
`;
const EMPTY = "flowchart LR\n    A[Start] --> B[End]\n";
const DRAFT_KEY = "mirrormaid:draft";
const AUTOSAVE_KEY = "mirrormaid:autosave";
const AUTOSAVE_DELAY = 600;

/**
 * Crash/reload recovery only. The real file lives on disk; the draft just keeps
 * what was on screen, plus whether it was linked to a file and saved.
 */
interface Draft {
  text: string;
  name: string;
  linked: boolean;
  unsaved: boolean;
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { linked: false, unsaved: true, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { text: SAMPLE, name: "untitled.mmd", linked: false, unsaved: true };
}

function loadAutosave(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

const idsOf = (fc: Flowchart) =>
  fc.ok
    ? { nodes: fc.nodes.map((n) => n.id), routes: routeKeys(fc).values() }
    : undefined;

export function App() {
  const initial = useMemo(() => {
    const draft = loadDraft();
    return { ...splitFile(draft.text), draft };
  }, []);

  const editor = useRef<CodeEditorHandle>(null);
  const [code, setCode] = useState(initial.code);
  const [layout, setLayout] = useState<Layout>(initial.layout);
  const [routes, setRoutes] = useState<Routes>(initial.routes);
  const [fileName, setFileName] = useState(initial.draft.name);
  /** The file on disk this diagram is linked to. Undefined = new, unsaved diagram. */
  const [handle, setHandle] = useState<FileSystemFileHandle>();
  /** A remembered file that needs a click to get access again (after a reload). */
  const [pendingHandle, setPendingHandle] = useState<FileSystemFileHandle>();
  /** File text as last read from / written to disk. Null = never saved. */
  const [savedText, setSavedText] = useState<string | null>(null);
  /** The user changed something since the file was loaded (opening alone never writes). */
  const [touched, setTouched] = useState(initial.draft.unsaved);
  const [saving, setSaving] = useState(false);
  /** The file changed on disk while we had unsaved edits. Autosave pauses. */
  const [conflict, setConflict] = useState(false);
  /** The browser hasn't granted write access yet. Autosave pauses until a click allows it. */
  const [needsPermission, setNeedsPermission] = useState(false);
  const [autosave, setAutosave] = useState(loadAutosave);
  const [autoEditId, setAutoEditId] = useState<string>();
  const [fitSignal, setFitSignal] = useState(0);
  const [split, setSplit] = useState(38);
  const [notice, setNotice] = useState<string>();
  const lastModified = useRef<number>(undefined);

  const fc = useMemo(() => parseFlowchart(code), [code]);
  // While the code is invalid the canvas shows the last valid diagram, read-only.
  const lastGood = useRef<Flowchart>(fc);
  if (fc.ok) lastGood.current = fc;
  const shown = fc.ok ? fc : lastGood.current;

  // Nodes without a stored position get auto-placed once and then keep that position.
  useEffect(() => {
    if (!fc.ok) return;
    const added = placeMissing(fc, layout);
    if (Object.keys(added).length) setLayout((l) => ({ ...l, ...added }));
  }, [fc, layout]);

  const fileText = useMemo(
    () => joinFile(code, layout, idsOf(fc), routes),
    [code, layout, routes, fc],
  );
  const dirty = savedText === null || (touched && fileText !== savedText);
  const mermaid = useMermaidCheck(fileText);

  // Keep a draft for reload/crash recovery.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const draft: Draft = {
          text: fileText,
          name: fileName,
          linked: !!(handle || pendingHandle),
          unsaved: dirty,
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [fileText, fileName, handle, pendingHandle, dirty]);

  useEffect(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, autosave ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [autosave]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // --- Canvas → text -----------------------------------------------------------
  const patch = (changes: Change[]) => editor.current?.apply(changes);

  const onAddNode = (pos: Pos) => {
    const id = nextNodeId(fc);
    setLayout((l) => ({ ...l, [id]: pos }));
    setAutoEditId(id);
    patch(addNode(code, fc, id, "New node"));
  };
  const onRename = (id: string, label: string) =>
    patch(renameNode(fc, id, label));
  const onChangeShape = (id: string, shape: Shape) =>
    patch(changeNodeShape(code, fc, id, shape));
  const onEdgeLabel = (edgeId: string, label: string) => {
    const edge = fc.edges.find((e) => e.id === edgeId);
    if (edge) patch(setEdgeLabel(fc, edge, label));
  };
  const onConnect = (from: string, to: string) =>
    patch(addEdge(code, fc, from, to));
  const onDelete = (nodeIds: string[], edgeIds: string[]) =>
    patch(deleteElements(code, fc, nodeIds, edgeIds));
  const onMove = (moved: Layout) => {
    // Routes between two nodes that moved together move along with them.
    const keys = routeKeys(fc);
    const shifted: Routes = {};
    for (const e of fc.edges) {
      const key = keys.get(e.id)!;
      const pts = routes[key];
      const a = moved[e.from];
      const b = moved[e.to];
      if (!pts || !a || !b || !layout[e.from]) continue;
      const dx = a.x - layout[e.from].x;
      const dy = a.y - layout[e.from].y;
      const bdx = b.x - (layout[e.to]?.x ?? NaN);
      const bdy = b.y - (layout[e.to]?.y ?? NaN);
      if (dx !== bdx || dy !== bdy || (dx === 0 && dy === 0)) continue;
      shifted[key] = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    setLayout((l) => ({ ...l, ...moved }));
    if (Object.keys(shifted).length) setRoutes((r) => ({ ...r, ...shifted }));
    setTouched(true);
  };
  const onRoute = (edgeId: string, points: Pos[]) => {
    const key = routeKeys(fc).get(edgeId);
    if (!key) return;
    setRoutes((r) => {
      const next = { ...r };
      if (points.length) next[key] = points;
      else delete next[key];
      return next;
    });
    setTouched(true);
  };
  const onCodeChange = (text: string) => {
    setCode(text);
    setTouched(true);
  };

  // --- Files -------------------------------------------------------------------
  const loadText = (
    text: string,
    name: string,
    h: FileSystemFileHandle | undefined,
    modified?: number,
    fit = true,
  ) => {
    const parts = splitFile(text);
    editor.current?.reset(parts.code); // fires onCodeChange, so reset `touched` after
    setLayout(parts.layout);
    setRoutes(parts.routes);
    setFileName(name);
    setHandle(h);
    setPendingHandle(undefined);
    setConflict(false);
    setNeedsPermission(false);
    setTouched(false);
    setSavedText(text.replace(/\r\n?/g, "\n"));
    lastModified.current = modified;
    if (fit) setFitSignal((s) => s + 1);
    if (parts.ignoredLines)
      setNotice(
        `Ignored ${parts.ignoredLines} unreadable line(s) in the layout block`,
      );
  };

  /** Writes serially. Autosave refuses to overwrite a file someone else changed. */
  const writeChain = useRef(Promise.resolve());
  const writeToDisk = useCallback(
    (h: FileSystemFileHandle, text: string, auto: boolean) => {
      writeChain.current = writeChain.current.then(async () => {
        try {
          if (auto && lastModified.current !== undefined) {
            const onDisk = await h.getFile();
            if (onDisk.lastModified !== lastModified.current) {
              setConflict(true);
              return;
            }
          }
          setSaving(true);
          // Manual saves come from a click and may ask for permission; autosave may not.
          await writeFile(h, text, !auto);
          lastModified.current = (await h.getFile()).lastModified;
          setSavedText(text);
          setConflict(false);
          setNeedsPermission(false);
          if (!auto) setNotice(`Saved ${h.name}`);
        } catch (e) {
          if (e instanceof WriteNotAllowedError) {
            setNeedsPermission(true);
            setNotice(
              auto
                ? `Auto-save paused: allow the browser to edit ${h.name}`
                : lastDenied
                  ? `Chrome blocks file editing for this site. Click the icon left of the address → Site settings → "File editing" → Ask, then reload.`
                  : `The browser did not allow editing ${h.name}. Check the site settings ("File editing"), or use "Download".`,
            );
          } else {
            setNotice(`Could not save ${h.name}: ${(e as Error).message}`);
          }
        } finally {
          setSaving(false);
        }
      });
      return writeChain.current;
    },
    [],
  );

  // Autosave: linked file + user changed something + nothing pending on disk.
  useEffect(() => {
    if (!handle || !autosave || !dirty || conflict || needsPermission) return;
    const t = setTimeout(
      () => void writeToDisk(handle, fileText, true),
      AUTOSAVE_DELAY,
    );
    return () => clearTimeout(t);
  }, [
    handle,
    autosave,
    dirty,
    conflict,
    needsPermission,
    fileText,
    writeToDisk,
  ]);

  /** Re-links a remembered file. `request` must come from a click. */
  const reconnect = async (h: FileSystemFileHandle, request: boolean) => {
    if (!(await ensurePermission(h, request))) {
      setPendingHandle(h);
      return;
    }
    try {
      const f = await h.getFile();
      const text = await f.text();
      if (initial.draft.unsaved || touched) {
        // Keep what's on screen, it is newer than the file. Autosave writes it.
        setHandle(h);
        setPendingHandle(undefined);
        setFileName(f.name);
        setSavedText(text.replace(/\r\n?/g, "\n"));
        setTouched(true);
        lastModified.current = f.lastModified;
        setNotice(`Reconnected ${f.name}, restored unsaved changes`);
      } else {
        loadText(text, f.name, h, f.lastModified);
      }
    } catch {
      setPendingHandle(undefined);
      void rememberHandle(undefined);
      setNotice(`${h.name} is no longer available, kept as a new diagram`);
    }
  };

  // On startup, re-link the file that was open before the reload.
  useEffect(() => {
    if (!initial.draft.linked) return;
    void recallHandle().then((h) => h && reconnect(h, false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up changes made outside (VS Code, an AI tool) when coming back to the tab.
  const latest = useRef({ dirty, savedText, loadText });
  latest.current = { dirty, savedText, loadText };
  useEffect(() => {
    if (!handle) return;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const f = await handle.getFile();
        if (f.lastModified === lastModified.current) return;
        const text = (await f.text()).replace(/\r\n?/g, "\n");
        if (text === latest.current.savedText) {
          lastModified.current = f.lastModified;
        } else if (latest.current.dirty) {
          setConflict(true);
        } else {
          latest.current.loadText(text, f.name, handle, f.lastModified, false);
          setNotice(`Reloaded ${f.name} (changed on disk)`);
        }
      } catch {
        /* file moved or deleted: the next save reports it */
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [handle]);

  const confirmDiscard = () =>
    !dirty || window.confirm("Discard unsaved changes?");

  const doOpen = useCallback(async () => {
    if (!confirmDiscard()) return;
    try {
      const f = await openFile();
      if (!f) return;
      const modified = f.handle
        ? (await f.handle.getFile()).lastModified
        : undefined;
      loadText(f.text, f.name, f.handle, modified);
      void rememberHandle(f.handle);
    } catch (e) {
      setNotice(`Could not open file: ${(e as Error).message}`);
    }
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSaveAs = useCallback(async () => {
    try {
      const f = await saveFileAs(fileText, fileName);
      if (!f) return;
      setFileName(f.name);
      setConflict(false);
      setPendingHandle(undefined);
      if (!f.handle) {
        setNotice(`Downloaded ${f.name}`);
        return;
      }
      // Link the chosen file even if writing failed: "Allow saving" finishes it.
      setHandle(f.handle);
      void rememberHandle(f.handle);
      if (f.written) {
        lastModified.current = (await f.handle.getFile()).lastModified;
        setSavedText(fileText);
        setNeedsPermission(false);
        setNotice(`Saved ${f.name}`);
      } else {
        lastModified.current = undefined;
        setNeedsPermission(true);
        setNotice(
          `Click "Allow saving" so the browser lets Mirrormaid write ${f.name}`,
        );
      }
    } catch (e) {
      setNotice(`Could not save: ${(e as Error).message}`);
    }
  }, [fileText, fileName]);

  const doSave = useCallback(async () => {
    if (handle) return writeToDisk(handle, fileText, false);
    if (pendingHandle) return reconnect(pendingHandle, true);
    return doSaveAs(); // new diagram: ask where to put it
  }, [handle, pendingHandle, fileText, writeToDisk, doSaveAs]); // eslint-disable-line react-hooks/exhaustive-deps

  const doReloadFromDisk = async () => {
    if (!handle) return;
    const f = await handle.getFile();
    loadText(await f.text(), f.name, handle, f.lastModified, false);
  };

  const doNew = () => {
    if (!confirmDiscard()) return;
    loadText(EMPTY, "untitled.mmd", undefined);
    setSavedText(null);
    void rememberHandle(undefined);
  };

  const doAutoLayout = () => {
    if (!fc.ok) return;
    setLayout(autoLayoutAll(fc));
    setRoutes({});
    setTouched(true);
    setFitSignal((s) => s + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void (e.shiftKey ? doSaveAs() : doSave());
      } else if (k === "o") {
        e.preventDefault();
        void doOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave, doSaveAs, doOpen]);

  // Unsaved edits to a real file: warn before closing. New diagrams live on in the draft.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty && handle) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty, handle]);

  const fileStatus = !handle
    ? pendingHandle
      ? "not connected"
      : "not saved yet"
    : conflict
      ? "changed on disk"
      : needsPermission
        ? "no write access"
        : saving
          ? "saving…"
          : dirty
            ? "unsaved"
            : "saved";

  // --- Splitter ------------------------------------------------------------------
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      setSplit(
        Math.min(75, Math.max(15, (ev.clientX / window.innerWidth) * 100)),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const firstError = fc.errors[0];
  const lineOf = (pos: number) => code.slice(0, pos).split("\n").length;

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">
          <svg
            className="brand-mark"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden
          >
            <rect
              x="1.5"
              y="2.5"
              width="7"
              height="5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <rect
              x="11.5"
              y="12.5"
              width="7"
              height="5"
              rx="1.5"
              stroke="currentColor"
              strokeWidth="1.6"
            />
            <path
              d="M5 7.5v3.5a1.5 1.5 0 0 0 1.5 1.5H11.5"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </svg>
          Mirrormaid
        </span>
        <button onClick={doNew}>New</button>
        <button onClick={doOpen} title="Open (⌘O)">
          Open
        </button>
        <button onClick={doSave} title="Save (⌘S)">
          {canWriteFiles ? "Save" : "Download"}
        </button>
        {canWriteFiles && (
          <button onClick={doSaveAs} title="Save as (⇧⌘S)">
            Save as…
          </button>
        )}
        <span className="sep" />
        <button onClick={doAutoLayout} disabled={!fc.ok}>
          Auto-layout
        </button>
        <span className="sep" />
        <span
          className="file"
          title={handle ? "Linked to a file on disk" : undefined}
        >
          <span className="file-name">{fileName}</span>
          <span
            className={`file-status ${
              conflict || needsPermission
                ? "warn"
                : !handle
                  ? "idle"
                  : dirty || saving
                    ? "dirty"
                    : ""
            }`}
          >
            {fileStatus}
          </span>
        </span>
        {pendingHandle && (
          <button
            className="primary"
            onClick={() => void reconnect(pendingHandle, true)}
          >
            Reconnect {pendingHandle.name}
          </button>
        )}
        {needsPermission && handle && !conflict && (
          <>
            <button
              className="primary"
              onClick={() => void writeToDisk(handle, fileText, false)}
            >
              Allow saving
            </button>
            <button
              className="outline"
              onClick={() => download(fileText, fileName)}
            >
              Download
            </button>
          </>
        )}
        {conflict && (
          <>
            <button className="outline" onClick={() => void doReloadFromDisk()}>
              Reload from disk
            </button>
            <button
              className="outline"
              onClick={() =>
                handle && void writeToDisk(handle, fileText, false)
              }
            >
              Overwrite
            </button>
          </>
        )}
        <span className="spacer" />
        {notice && (
          <span className="notice" title={notice}>
            {notice}
          </span>
        )}
        {canWriteFiles && (
          <label
            className="autosave"
            title="Write every change to the linked file"
          >
            <input
              type="checkbox"
              checked={autosave}
              onChange={(e) => setAutosave(e.target.checked)}
            />
            Auto-save
          </label>
        )}
      </header>
      <main
        className="panes"
        style={{ gridTemplateColumns: `${split}% 1px 1fr` }}
      >
        <section className="pane code-pane">
          <div className="pane-header">
            Code
            <span
              className={`chip ${mermaid.state}`}
              title={
                mermaid.state === "error"
                  ? mermaid.message
                  : "Checked with the official Mermaid parser"
              }
            >
              {mermaid.state === "ok"
                ? "Valid Mermaid"
                : mermaid.state === "error"
                  ? "Mermaid rejects this"
                  : "Checking…"}
            </span>
          </div>
          <CodeEditor
            ref={editor}
            initial={initial.code}
            errors={fc.errors}
            onChange={onCodeChange}
          />
          {firstError && (
            <div className="error-bar">
              <strong>Line {lineOf(firstError.from)}</strong>
              <span>{firstError.message}</span>
            </div>
          )}
        </section>
        <div className="divider" onPointerDown={startDrag} />
        <section className="pane">
          <div className="pane-header">Diagram</div>
          <ReactFlowProvider>
            <Canvas
              fc={shown}
              layout={layout}
              routes={routes}
              readOnly={!fc.ok}
              autoEditId={autoEditId}
              fitSignal={fitSignal}
              onMove={onMove}
              onRename={onRename}
              onChangeShape={onChangeShape}
              onRoute={onRoute}
              onEdgeLabel={onEdgeLabel}
              onConnect={onConnect}
              onAddNode={onAddNode}
              onDelete={onDelete}
              onAutoEditDone={() => setAutoEditId(undefined)}
            />
          </ReactFlowProvider>
          {!fc.ok && (
            <div className="readonly-badge">
              Fix the code to edit the diagram
            </div>
          )}
          {fc.ok && (
            <div className="hint">
              <kbd>Double-click</kbd> canvas to add · <kbd>Double-click</kbd> to
              rename · <kbd>Right-click</kbd> to change type · <kbd>Drag</kbd>{" "}
              handle to connect · <kbd>Drag</kbd> edge to bend · <kbd>⌫</kbd>{" "}
              delete
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
