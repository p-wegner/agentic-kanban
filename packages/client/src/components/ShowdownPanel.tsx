import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";
import type { ShowdownResponse, ShowdownContestantResult, DiffResponse } from "@agentic-kanban/shared";
import { DiffViewer } from "./DiffViewer.js";

interface ShowdownPanelProps {
  showdownId: string;
  onClose: () => void;
  onWinnerPicked: () => void;
}

const SLOT_LABELS = ["A", "B", "C", "D"];
const SLOT_COLORS = [
  { badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300", border: "border-blue-200 dark:border-blue-800" },
  { badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300", border: "border-purple-200 dark:border-purple-800" },
  { badge: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300", border: "border-teal-200 dark:border-teal-800" },
  { badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300", border: "border-orange-200 dark:border-orange-800" },
];

function ContestantDiff({ contestant }: { contestant: ShowdownContestantResult }) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<DiffResponse>(`/api/workspaces/${contestant.workspaceId}/diff`)
      .then(d => { if (!cancelled) { setDiff(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contestant.workspaceId]);

  if (loading) return <div className="text-xs text-gray-400 italic py-2">Loading diff…</div>;
  if (!diff || !diff.diff) return <div className="text-xs text-gray-400 italic py-2">No changes yet</div>;

  return (
    <div>
      <button
        onClick={() => setExpanded(v => !v)}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline mb-1"
      >
        {expanded ? "Hide diff" : `Show diff (${diff.stats.filesChanged} file${diff.stats.filesChanged !== 1 ? "s" : ""})`}
      </button>
      {expanded && (
        <div className="max-h-64 overflow-y-auto rounded border border-gray-200 dark:border-gray-700 text-xs">
          <DiffViewer diff={diff.diff} stats={diff.stats} comments={[]} />
        </div>
      )}
    </div>
  );
}

export function ShowdownPanel({ showdownId, onClose, onWinnerPicked }: ShowdownPanelProps) {
  const [showdown, setShowdown] = useState<ShowdownResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickingWinner, setPickingWinner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    function poll() {
      apiFetch<ShowdownResponse>(`/api/showdowns/${showdownId}`)
        .then(s => {
          if (!cancelled) {
            setShowdown(s);
            setLoading(false);
            // Keep polling if still active
            if (s.status === "active") {
              timer = setTimeout(poll, 5000);
            }
          }
        })
        .catch(() => { if (!cancelled) setLoading(false); });
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [showdownId]);

  async function pickWinner(workspaceId: string) {
    if (pickingWinner) return;
    setPickingWinner(workspaceId);
    try {
      await apiFetch<ShowdownResponse>(`/api/showdowns/${showdownId}/pick-winner`, {
        method: "POST",
        body: JSON.stringify({ winnerWorkspaceId: workspaceId }),
      });
      showToast("Winner picked! Loser branches deleted.", "success");
      onWinnerPicked();
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to pick winner", "error");
      setPickingWinner(null);
    }
  }

  const allDone = showdown?.contestants.every(c => c.status === "idle" || c.status === "closed");
  const doneCount = showdown?.contestants.filter(c => c.status === "idle" || c.status === "closed").length ?? 0;
  const total = showdown?.contestants.length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-4xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">⚔️</span>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Showdown
                {showdown?.status === "decided" && (
                  <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/50 px-1.5 py-0.5 rounded">Decided</span>
                )}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {loading ? "Loading…" : `${doneCount}/${total} contestants done`}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">&times;</button>
        </div>

        {/* Contestants grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <svg className="animate-spin h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Loading showdown…
            </div>
          ) : showdown ? (
            <div className={`grid gap-4 ${showdown.contestants.length === 2 ? "grid-cols-2" : showdown.contestants.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {showdown.contestants.map((contestant, idx) => {
                const colors = SLOT_COLORS[idx % SLOT_COLORS.length];
                const isWinner = showdown.winnerWorkspaceId === contestant.workspaceId;
                const isDone = contestant.status === "idle" || contestant.status === "closed";
                const isPicking = pickingWinner === contestant.workspaceId;

                return (
                  <div
                    key={contestant.workspaceId}
                    className={`rounded-lg border-2 p-4 flex flex-col gap-3 ${
                      isWinner
                        ? "border-green-400 dark:border-green-600 bg-green-50 dark:bg-green-900/20"
                        : colors.border
                    } bg-white dark:bg-gray-800`}
                  >
                    {/* Contestant header */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${colors.badge}`}>
                          {SLOT_LABELS[idx] ?? idx}
                        </span>
                        {isWinner && (
                          <span className="text-xs font-medium text-green-600 dark:text-green-400">🏆 Winner</span>
                        )}
                      </div>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        contestant.status === "active" ? "bg-green-100 text-green-700" :
                        contestant.status === "idle" ? "bg-amber-100 text-amber-700" :
                        contestant.status === "closed" ? "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {contestant.status}
                      </span>
                    </div>

                    {/* Metadata */}
                    <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400 dark:text-gray-500">Skill:</span>
                        <span className="text-gray-700 dark:text-gray-300 font-medium">{contestant.skillName ?? "default"}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-gray-400 dark:text-gray-500">Model:</span>
                        <span className="text-gray-700 dark:text-gray-300 font-medium">{contestant.model || "default"}</span>
                      </div>
                      {contestant.diffStats && (
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <span className="text-gray-400">Diff:</span>
                          <span className="font-medium text-gray-600 dark:text-gray-300">{contestant.diffStats.filesChanged} files</span>
                          <span className="text-green-600">+{contestant.diffStats.insertions}</span>
                          <span className="text-red-500">−{contestant.diffStats.deletions}</span>
                        </div>
                      )}
                      <div className="font-mono text-[10px] text-gray-400 truncate" title={contestant.branch}>{contestant.branch}</div>
                    </div>

                    {/* Diff view */}
                    {isDone && <ContestantDiff contestant={contestant} />}
                    {!isDone && contestant.status === "active" && (
                      <div className="text-xs text-gray-400 italic flex items-center gap-1">
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                        Agent running…
                      </div>
                    )}

                    {/* Pick winner button */}
                    {showdown.status === "active" && isDone && !isWinner && (
                      <button
                        onClick={() => pickWinner(contestant.workspaceId)}
                        disabled={!!pickingWinner}
                        className="mt-auto w-full text-xs font-medium px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
                      >
                        {isPicking ? (
                          <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                          </svg>
                        ) : "🏆"}
                        {isPicking ? "Merging…" : "Pick as winner"}
                      </button>
                    )}

                    {showdown.status === "active" && !isDone && (
                      <p className="mt-auto text-[10px] text-gray-400 italic text-center">
                        Waiting for agent to finish…
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-8">Showdown not found.</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0 flex items-center justify-between">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {showdown?.status === "active"
              ? "Pick a winner to merge that branch and delete the others"
              : showdown?.status === "decided"
              ? "Showdown decided — winner was merged, losers deleted"
              : ""}
          </p>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
