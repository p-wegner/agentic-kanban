import { useEffect, useRef, useState } from "react";
import type { ProjectScriptShortcutResponse } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface ProjectScriptsMenuProps {
  projectId: string | null;
}

type RunState = {
  script: ProjectScriptShortcutResponse;
  output: string;
  status: "running" | "success" | "failed" | "error";
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
};

export function scriptStatusLabel(script: ProjectScriptShortcutResponse): string {
  if (!script.lastRun) return "Not run";
  if (script.lastRun.status === "running") return "Running";
  if (script.lastRun.status === "success") return "Passed";
  if (script.lastRun.status === "failed") return `Failed ${script.lastRun.exitCode ?? ""}`.trim();
  return "Error";
}

export function ProjectScriptsMenu({ projectId }: ProjectScriptsMenuProps) {
  const [open, setOpen] = useState(false);
  const [scripts, setScripts] = useState<ProjectScriptShortcutResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [runState, setRunState] = useState<RunState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    apiFetch<ProjectScriptShortcutResponse[]>(`/api/projects/${projectId}/scripts`)
      .then(setScripts)
      .catch(() => showToast("Failed to load scripts", "error"))
      .finally(() => setLoading(false));
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  async function refreshScripts() {
    if (!projectId) return;
    try {
      setScripts(await apiFetch<ProjectScriptShortcutResponse[]>(`/api/projects/${projectId}/scripts`));
    } catch {
      // Non-critical after a run; the streamed panel already shows the result.
    }
  }

  async function runScript(script: ProjectScriptShortcutResponse) {
    if (!projectId) return;
    setOpen(false);
    setRunState({
      script,
      output: "",
      status: "running",
      startedAt: null,
      endedAt: null,
      exitCode: null,
    });
    try {
      const response = await fetch(`/api/projects/${projectId}/scripts/${script.id}/run`, { method: "POST" });
      if (!response.ok || !response.body) throw new Error(`Script run failed: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      function processFrame(frame: string) {
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (!line) return;
        const event = JSON.parse(line.slice(6));
        if (event.type === "start") {
          setRunState((state) => state && { ...state, startedAt: event.startedAt });
        } else if (event.type === "stdout" || event.type === "stderr") {
          setRunState((state) => state && { ...state, output: state.output + event.data });
        } else if (event.type === "exit") {
          setRunState((state) => state && {
            ...state,
            status: event.status,
            exitCode: event.exitCode,
            endedAt: event.endedAt,
          });
        }
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) processFrame(frame);
      }
      for (const frame of buffer.split("\n\n").filter(Boolean)) processFrame(frame);
      await refreshScripts();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Script run failed";
      setRunState((state) => state && {
        ...state,
        status: "error",
        endedAt: new Date().toISOString(),
        output: state.output + `${message}\n`,
      });
      showToast(message, "error");
    }
  }

  return (
    <>
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={!projectId}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Project scripts"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h10M4 17h7" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
          </svg>
          <span className="hidden sm:inline">Scripts</span>
        </button>
        {open && (
          <div
            role="menu"
            className="absolute top-full left-0 mt-1 w-72 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-30 p-1"
          >
            {loading && <div className="px-3 py-2 text-xs text-gray-500">Loading scripts...</div>}
            {!loading && scripts.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-500">No scripts configured in Settings.</div>
            )}
            {!loading && scripts.map((script) => (
              <button
                key={script.id}
                type="button"
                role="menuitem"
                onClick={() => runScript(script)}
                className="w-full text-left px-2.5 py-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{script.name}</span>
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 shrink-0">{scriptStatusLabel(script)}</span>
                </div>
                <div className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate mt-0.5">{script.command}</div>
                {script.description && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">{script.description}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {runState && (
        <>
          <div className="fixed inset-0 bg-black/30 z-50" onClick={() => runState.status !== "running" && setRunState(null)} />
          <div className="fixed bottom-4 right-4 z-50 w-[min(720px,calc(100vw-2rem))] max-h-[70vh] bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{runState.script.name}</h3>
                <p className="text-xs font-mono text-gray-500 dark:text-gray-400 truncate">{runState.script.command}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-xs font-medium ${
                  runState.status === "success" ? "text-emerald-600" :
                    runState.status === "failed" || runState.status === "error" ? "text-red-600" : "text-amber-600"
                }`}>
                  {runState.status === "running" ? "Running" : `Exit ${runState.exitCode ?? "error"}`}
                </span>
                <button
                  type="button"
                  disabled={runState.status === "running"}
                  onClick={() => setRunState(null)}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-40"
                >
                  &times;
                </button>
              </div>
            </div>
            <pre className="m-0 p-3 text-xs font-mono leading-relaxed bg-gray-950 text-gray-100 overflow-auto flex-1 min-h-[180px] whitespace-pre-wrap">
              {runState.output || "Waiting for output..."}
            </pre>
          </div>
        </>
      )}
    </>
  );
}
