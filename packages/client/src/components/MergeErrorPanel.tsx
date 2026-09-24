import { useState } from "react";
import { showToast } from "../lib/toast.js";
import { bankShrinksAndRetry, type MergeJobHandlers } from "../lib/mergeJobTracker.js";
import type { MergeErrorState } from "../lib/mergeJobBadge.js";

/**
 * The inline merge-error banner (extracted from `WorkspaceCard`, which is on the nloc ring),
 * now with the #1250 affordance: when the failure is a stale shrink-only baseline the server
 * parsed into a fix hint, "Bank shrinks and retry" commits the edits on the branch and
 * re-triggers the merge — one click for what the operator did by hand on #1243. "Fix & Merge
 * with AI" stays beside it for every other red.
 */
export function MergeErrorPanel({ wsId, mergeError, actionLoading, onFixAndMerge, mergeHandlers }: {
  wsId: string;
  mergeError: MergeErrorState;
  actionLoading: boolean;
  onFixAndMerge: (wsId: string, errorMessage: string) => void;
  mergeHandlers: MergeJobHandlers;
}) {
  const [banking, setBanking] = useState(false);
  const hint = mergeError.fixHint ?? null;

  async function bank() {
    setBanking(true);
    try {
      const { committed } = await bankShrinksAndRetry(wsId, mergeHandlers);
      showToast(`Banked ${hint?.edits.length ?? 0} baseline shrink(s) in ${committed.slice(0, 10)} — merge re-triggered`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Banking the shrinks failed", "error");
    } finally {
      setBanking(false);
    }
  }

  return (
    <div className="mt-2 p-2 bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 rounded" data-testid="merge-error-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-orange-700 dark:text-orange-400">
          {hint ? "Merge failed on a stale baseline -- bank the shrinks and retry" : "Merge failed -- AI can fix and retry"}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {hint && hint.kind === "bank-shrinks" && (
            <button
              onClick={() => { void bank(); }}
              disabled={actionLoading || banking}
              title={hint.summary}
              className="text-xs bg-emerald-600 text-white px-2 py-1 rounded hover:bg-emerald-700 disabled:opacity-50"
            >
              {banking ? "Banking…" : "Bank shrinks and retry"}
            </button>
          )}
          <button
            onClick={() => onFixAndMerge(wsId, mergeError.message)}
            disabled={actionLoading || banking}
            className="text-xs bg-orange-600 text-white px-2 py-1 rounded hover:bg-orange-700 disabled:opacity-50"
          >
            Fix &amp; Merge with AI
          </button>
        </div>
      </div>
      {hint && (
        <ul className="mt-1 text-xs text-orange-700 dark:text-orange-300 font-mono" data-testid="merge-fix-hint">
          {hint.edits.map((e) => (
            <li key={`${e.baselineFile}::${e.key}`}>{e.key}: {e.from ?? "?"} → {e.to} <span className="text-orange-500">({e.baselineFile})</span></li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-orange-600 dark:text-orange-400 font-mono break-all whitespace-pre-wrap">{mergeError.message}</p>
    </div>
  );
}
