import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface WfNode {
  id: string;
  name: string;
  nodeType: string;
  statusName: string | null;
  skillName: string | null;
  sortOrder: number;
}
interface WfEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string | null;
  condition: string;
}
interface WfTransition {
  id: string;
  fromNodeId: string | null;
  toNodeId: string;
  summary: string | null;
  triggeredBy: string;
  createdAt: string;
}
interface NextTransition {
  toNodeId: string;
  toNodeName: string;
  label: string | null;
  condition: string;
  verdict?: "fire" | "block" | "manual";
}
interface Progress {
  workspaceId: string;
  templateId: string | null;
  currentNodeId: string | null;
  nextTransitions: NextTransition[];
  transitions: WfTransition[];
  nodes: WfNode[];
  edges: WfEdge[];
}

const NODE_TYPE_BADGE: Record<string, string> = {
  start: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  end: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  "parallel-fork": "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
  "parallel-join": "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
};

/**
 * Per-workspace workflow progress: shows the template's stages with the current
 * one highlighted, the transition history, and (when not terminal) buttons to
 * advance the workflow manually.
 */
export function WorkflowProgress({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);

  const load = useCallback(() => {
    apiFetch<Progress>(`/api/workflows/workspaces/${workspaceId}/progress`)
      .then(setProgress)
      .catch(() => setProgress(null))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // Auto-refresh when a workflow_transition event arrives via the board WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/board/${projectId}`;
    const ws = new WebSocket(url);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "board_changed" && msg.reason === "workflow_transition") {
          load();
        }
      } catch { /* ignore malformed */ }
    };
    return () => {
      ws.onclose = null;
      ws.close();
    };
  }, [projectId, load]);

  async function transition(toNodeId: string, toNodeName: string) {
    if (transitioning) return;
    setTransitioning(true);
    try {
      await apiFetch(`/api/workflows/workspaces/${workspaceId}/transition`, {
        method: "POST",
        body: JSON.stringify({ toNodeId, summary: `Manually advanced to ${toNodeName}` }),
      });
      showToast(`Advanced to ${toNodeName}`, "success");
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Transition failed", "error");
    } finally {
      setTransitioning(false);
    }
  }

  if (loading) return null;
  if (!progress || !progress.templateId || progress.nodes.length === 0) return null;

  const visitedNodeIds = new Set(progress.transitions.map((t) => t.toNodeId));
  const nodeName = (id: string | null) =>
    id ? progress.nodes.find((n) => n.id === id)?.name ?? "?" : "start";

  return (
    <div className="mt-3 rounded-md border border-gray-200 dark:border-gray-700 p-3">
      <h4 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
        Workflow
      </h4>

      {/* Stage list */}
      <ol className="space-y-1">
        {progress.nodes.map((n) => {
          const isCurrent = n.id === progress.currentNodeId;
          const isVisited = visitedNodeIds.has(n.id);
          return (
            <li
              key={n.id}
              className={`flex items-center gap-2 text-sm rounded px-2 py-1 ${
                isCurrent
                  ? "bg-blue-50 dark:bg-blue-900/30 ring-1 ring-blue-300 dark:ring-blue-700"
                  : ""
              }`}
            >
              <span
                className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                  isCurrent
                    ? "bg-blue-500"
                    : isVisited
                    ? "bg-green-500"
                    : "bg-gray-300 dark:bg-gray-600"
                }`}
              />
              <span className={isCurrent ? "font-semibold text-gray-900 dark:text-gray-100" : "text-gray-700 dark:text-gray-300"}>
                {n.name}
              </span>
              {n.nodeType !== "normal" && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${NODE_TYPE_BADGE[n.nodeType] ?? ""}`}>
                  {n.nodeType}
                </span>
              )}
              {n.statusName && (
                <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-auto">{n.statusName}</span>
              )}
              {n.skillName && (
                <span className="text-[10px] text-brand-600 dark:text-brand-400" title="skill attached to this stage">
                  ⚙ {n.skillName}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {/* Next-stage actions */}
      {progress.nextTransitions.length > 0 && (
        <div className="mt-3">
          <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">Advance to:</div>
          <div className="flex flex-wrap gap-1.5">
            {progress.nextTransitions.map((t) => {
              const isBlocked = t.verdict === "block";
              const isFireable = t.verdict === "fire";
              return (
                <button
                  key={t.toNodeId}
                  type="button"
                  disabled={transitioning || isBlocked}
                  onClick={() => transition(t.toNodeId, t.toNodeName)}
                  title={t.label ?? undefined}
                  className={`text-xs px-2 py-1 rounded border text-blue-700 dark:text-blue-300 disabled:opacity-50 ${
                    isBlocked
                      ? "border-gray-300 dark:border-gray-600 opacity-50 cursor-not-allowed hover:bg-transparent dark:hover:bg-transparent"
                      : isFireable
                        ? "border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 ring-1 ring-blue-200 dark:ring-blue-800"
                        : "border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                  }`}
                >
                  {t.toNodeName}
                  {t.condition !== "manual" && (
                    <span className={`text-[10px] ${isBlocked ? "text-red-500 dark:text-red-400" : "opacity-60"}`}>
                      {" "}({t.condition})
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Transition history */}
      {progress.transitions.length > 0 && (
        <details className="mt-3">
          <summary className="text-[11px] text-gray-500 dark:text-gray-400 cursor-pointer">
            History ({progress.transitions.length})
          </summary>
          <ul className="mt-1 space-y-0.5">
            {progress.transitions.map((t) => (
              <li key={t.id} className="text-[11px] text-gray-500 dark:text-gray-400">
                <span className="text-gray-400 dark:text-gray-500">{nodeName(t.fromNodeId)}</span>
                {" → "}
                <span className="text-gray-700 dark:text-gray-300">{nodeName(t.toNodeId)}</span>
                {t.summary ? ` — ${t.summary}` : ""}
                <span className="opacity-60"> [{t.triggeredBy}]</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
