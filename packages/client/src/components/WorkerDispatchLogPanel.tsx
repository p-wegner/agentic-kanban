import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";

interface PlacementRow {
  sessionId: string;
  workspaceId: string;
  branch: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  status: string;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  placement: "remote" | "host";
  workerId: string | null;
  workerName: string | null;
  placementReason: string | null;
  placementDetail: string | null;
}

interface ExplainCheck {
  id: string;
  title: string;
  outcome: string;
  detail: string;
}

interface ExplainResponse {
  explanation: {
    summary: string;
    chain: ExplainCheck[];
    decidedBy: string | null;
    agreesWithResolver: boolean;
  };
}

interface WorkerDispatchLogPanelProps {
  projectId: string | null;
}

/**
 * Dispatch Log tab (#1089): where recent sessions actually ran (host or a named worker) and
 * why, plus an "Explain #N" box against `/api/workers/explain` for a ticket that has not
 * dispatched at all yet.
 */
export function WorkerDispatchLogPanel({ projectId }: WorkerDispatchLogPanelProps) {
  const [placements, setPlacements] = useState<PlacementRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issueInput, setIssueInput] = useState("");
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [explainLoading, setExplainLoading] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (projectId) params.set("projectId", projectId);
    apiFetch<{ placements: PlacementRow[] }>(`/api/workers/placements?${params}`)
      .then((r) => setPlacements(r.placements))
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

  const runExplain = async () => {
    const issue = Number(issueInput);
    if (!Number.isInteger(issue) || issue <= 0) {
      setExplainError("Enter a positive issue number");
      return;
    }
    setExplainLoading(true);
    setExplainError(null);
    setExplain(null);
    try {
      const params = new URLSearchParams({ issue: String(issue) });
      if (projectId) params.set("projectId", projectId);
      const res = await apiFetch<ExplainResponse>(`/api/workers/explain?${params}`);
      setExplain(res);
    } catch (err) {
      setExplainError(errorMessage(err));
    } finally {
      setExplainLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
        <div className="text-sm font-medium text-ink dark:text-stone-100 mb-2">Explain a ticket</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={issueInput}
            onChange={(e) => setIssueInput(e.target.value)}
            placeholder="Issue #"
            className="w-28 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm"
          />
          <button
            onClick={runExplain}
            disabled={explainLoading}
            className="rounded bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-700 disabled:opacity-50"
          >
            Explain
          </button>
        </div>
        {explainError && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{explainError}</div>}
        {explain && (
          <div className="mt-3 space-y-2">
            <div className="text-sm text-ink dark:text-stone-100">{explain.explanation.summary}</div>
            {!explain.explanation.agreesWithResolver && (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                This explanation no longer matches the resolver's live decision — treat it as stale.
              </div>
            )}
            <ul className="space-y-1">
              {explain.explanation.chain.map((check) => (
                <li key={check.id} className="text-xs text-gray-600 dark:text-gray-300">
                  <span
                    className={
                      check.id === explain.explanation.decidedBy
                        ? "font-medium text-ink dark:text-stone-100"
                        : ""
                    }
                  >
                    [{check.outcome}]
                  </span>{" "}
                  {check.title} — {check.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div>
        <div className="text-sm font-medium text-ink dark:text-stone-100 mb-2">Recent placements</div>
        {error && <div className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</div>}
        {placements && placements.length === 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">No sessions recorded yet.</div>
        )}
        <ul className="space-y-1">
          {placements?.map((p) => (
            <li key={p.sessionId} className="rounded border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink dark:text-stone-100">
                  {p.issueNumber ? `#${p.issueNumber} ${p.issueTitle ?? ""}` : (p.branch ?? p.workspaceId)}
                </span>
                <span className="text-gray-500 dark:text-gray-400">{p.status}</span>
              </div>
              <div className="mt-1 text-gray-500 dark:text-gray-400">
                {p.startedAt} on{" "}
                {p.placement === "remote" ? `worker ${p.workerName ?? `${p.workerId} (revoked)`}` : "host"} · {p.executor}
              </div>
              {p.placementReason && (
                <div className="mt-0.5 text-gray-400 dark:text-gray-500">
                  why: {p.placementReason} — {p.placementDetail ?? ""}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
