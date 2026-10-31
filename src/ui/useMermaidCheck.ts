import { useEffect, useState } from "react";

export type MermaidStatus =
  { state: "checking" } | { state: "ok" } | { state: "error"; message: string };

let mermaidPromise: Promise<typeof import("mermaid").default> | undefined;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false });
    return m.default;
  });
  return mermaidPromise;
}

/**
 * Checks the full file (including the layout block) with the real Mermaid parser,
 * i.e. "will this render on GitHub?". Mermaid is only loaded for this, lazily.
 */
export function useMermaidCheck(text: string, delay = 600): MermaidStatus {
  const [status, setStatus] = useState<MermaidStatus>({ state: "checking" });
  useEffect(() => {
    let cancelled = false;
    setStatus({ state: "checking" });
    const t = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        await mermaid.parse(text);
        if (!cancelled) setStatus({ state: "ok" });
      } catch (e) {
        if (!cancelled)
          setStatus({
            state: "error",
            message: e instanceof Error ? e.message : String(e),
          });
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text, delay]);
  return status;
}
