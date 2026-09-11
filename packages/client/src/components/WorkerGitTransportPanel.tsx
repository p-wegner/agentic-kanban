import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";

interface IncomingRefRow {
  projectId: string;
  projectName: string;
  branch: string;
  sha: string;
  heldReason: string | null;
  ageMs: number;
  stale: boolean;
}

interface WorkerGitTransportPanelProps {
  projectId: string | null;
}

/**
 * Git Transport tab (#1089): the refs a worker pushed over git-over-HTTP that the board has
 * not fast-forwarded yet. Never forced automatically — land or discard each one deliberately,
 * same rule `WorkerFleetPanel` documented before this tab absorbed the list.
 */
export function WorkerGitTransportPanel({ projectId }: WorkerGitTransportPanelProps) {
  const [refs, setRefs] = useState<IncomingRefRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    apiFetch<{ refs: IncomingRefRow[] }>(`/api/workers/incoming?${params}`)
      .then((r) => setRefs(r.refs))
      .catch((err) => setError(errorMessage(err)));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<BoardWsEventDetail>).detail;
      if (detail?.reason === "workers_changed") load();
    };
    window.addEventListener(BOARD_WS_EVENT, handler);
    return () => window.removeEventListener(BOARD_WS_EVENT, handler);
  }, [load]);

  const key = (ref: IncomingRefRow) => `${ref.projectId}:${ref.branch}`;

  const land = async (ref: IncomingRefRow) => {
    setBusy(key(ref));
    setError(null);
    try {
      await apiPost("/api/workers/incoming/land", { projectId: ref.projectId, branch: ref.branch });
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (ref: IncomingRefRow) => {
    if (!confirm(`Discard the incoming ref for "${ref.branch}"? Its commits are dropped.`)) return;
    setBusy(key(ref));
    setError(null);
    try {
      await apiPost("/api/workers/incoming/discard", { projectId: ref.projectId, branch: ref.branch });
      load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {refs && refs.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
          No held incoming refs. Workers fast-forward cleanly landed branches automatically.
        </div>
      )}
      {refs?.map((ref) => (
        <div
          key={key(ref)}
          className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-amber-900 dark:text-amber-100">
                <code>{ref.branch}</code> in {ref.projectName}
              </div>
              <div className="text-xs text-amber-700 dark:text-amber-300">
                {ref.heldReason ?? "landable"} · sha <code>{ref.sha.slice(0, 8)}</code>
                {ref.stale && " · stale"}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                onClick={() => land(ref)}
                disabled={busy === key(ref)}
                className="rounded bg-accent-600 px-2 py-1 text-xs text-white hover:bg-accent-700 disabled:opacity-50"
              >
                Land
              </button>
              <button
                onClick={() => discard(ref)}
                disabled={busy === key(ref)}
                className="rounded border border-amber-300 dark:border-amber-700 px-2 py-1 text-xs text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
