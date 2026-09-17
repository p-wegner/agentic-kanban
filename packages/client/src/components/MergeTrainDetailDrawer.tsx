import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatDuration } from "../lib/insights-format.js";
import {
  buildBisectTree,
  computeBisectTreeStats,
  culpritPathLabels,
  type BisectTreeNode,
  type MergeTrainAttemptVerdict,
} from "../lib/mergeTrainBisectTree.js";
import type { MergeTrainRowDto } from "../lib/mergeTrainSummary.js";
import { Icon } from "./Icon.js";

interface MergeTrainDetailDrawerProps {
  projectId: string;
  trainId: string;
  onClose: () => void;
}

/** How often to re-poll while the train is still running (#1189: "live-updating"). */
const LIVE_POLL_MS = 4000;
const LIVE_STATES = new Set(["assembling", "gating", "landing"]);

function parseAttempts(row: MergeTrainRowDto | null): ReturnType<typeof buildBisectTree> {
  if (!row?.gateEvidence) return [];
  try {
    const parsed = JSON.parse(row.gateEvidence) as { attempts?: unknown };
    if (!Array.isArray(parsed.attempts)) return [];
    return buildBisectTree(parsed.attempts as Parameters<typeof buildBisectTree>[0]);
  } catch {
    return [];
  }
}

function verdictLabel(verdict: MergeTrainAttemptVerdict): string {
  switch (verdict) {
    case "landed":
      return "Landed";
    case "red":
      return "Red";
    case "assembly_empty":
      return "No members assembled";
    case "land_refused":
      return "Land refused";
    case "env_failure":
      return "Environment failure";
    default:
      return verdict;
  }
}

function verdictClasses(verdict: MergeTrainAttemptVerdict): string {
  switch (verdict) {
    case "landed":
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
    case "red":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "env_failure":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "land_refused":
      return "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300";
    case "assembly_empty":
    default:
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
  }
}

function TreeNode({ node, highlighted }: { node: BisectTreeNode; highlighted: Set<string> }) {
  const { attempt } = node;
  const onPath = highlighted.has(attempt.label);
  return (
    <div className="ml-4 border-l border-gray-200 dark:border-gray-700 pl-3 pt-2">
      <div
        className={`flex flex-wrap items-center gap-2 text-xs rounded px-2 py-1 ${
          onPath ? "bg-red-50 dark:bg-red-950/30 ring-1 ring-red-300 dark:ring-red-800" : ""
        }`}
      >
        <span className="font-mono text-gray-500 dark:text-gray-400">{attempt.label}</span>
        <span className={`px-2 py-0.5 rounded-full font-medium ${verdictClasses(attempt.verdict)}`}>
          {verdictLabel(attempt.verdict)}
        </span>
        <span className="text-gray-500 dark:text-gray-400">
          {attempt.included.length}/{attempt.members.length} assembled
        </span>
        {attempt.dropped.length > 0 && (
          <span className="text-gray-400 dark:text-gray-500" title={attempt.dropped.map((d) => d.reason).join("; ")}>
            {attempt.dropped.length} dropped
          </span>
        )}
        <span className="text-gray-400 dark:text-gray-500">
          {node.durationMs != null ? formatDuration(node.durationMs) : "no gate"}
        </span>
        {attempt.failureHead && (
          <span
            className="text-red-500 dark:text-red-400 truncate max-w-[280px] font-mono"
            title={attempt.failureHead}
          >
            {attempt.failureHead}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNode key={child.attempt.label} node={child} highlighted={highlighted} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Train detail drawer (#1189) — renders the bisect tree persisted under a train row's
 * `gateEvidence.attempts` (each a `runTrainAttempt` node, appended as it finishes). Opened from
 * the merge-queue's "Merge train" summary bar or a history tile. Polls while the train is
 * still running so the tree fills in live instead of appearing whole only at the end.
 */
export function MergeTrainDetailDrawer({ projectId, trainId, onClose }: MergeTrainDetailDrawerProps) {
  const [row, setRow] = useState<MergeTrainRowDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const result = await apiFetch<{ ok: boolean; trains: MergeTrainRowDto[] }>(
          `/api/merge-queue/trains?projectId=${encodeURIComponent(projectId)}`,
        );
        if (cancelled) return;
        const found = result.trains.find((t) => t.id === trainId) ?? null;
        setRow(found);
        setError(found ? null : "Train not found");
        if (found && LIVE_STATES.has(found.state)) {
          timer = setTimeout(() => void load(), LIVE_POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load train detail");
      }
    }
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, trainId]);

  const roots = parseAttempts(row);
  const stats = computeBisectTreeStats(roots);
  const highlighted = culpritPathLabels(roots);
  const isLive = row ? LIVE_STATES.has(row.state) : false;

  return (
    <div className="fixed inset-0 z-[60] flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[min(640px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="w-5 h-5 text-orange-600" d="M9 5l7 7-7 7" />
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif truncate">
              Train {row?.label ?? trainId}
            </h2>
            {isLive && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 uppercase tracking-wide font-semibold animate-pulse">
                Live
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
            aria-label="Close train detail"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-red-600 dark:text-red-400 border-b border-gray-100 dark:border-gray-800">
            {error}
          </div>
        )}

        {row && (
          <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
            <span>
              Gate runs: <strong className="font-medium text-gray-800 dark:text-gray-100">{stats.totalGateRuns}</strong>
            </span>
            <span>
              Gate time: <strong className="font-medium text-gray-800 dark:text-gray-100">{formatDuration(stats.totalGateDurationMs)}</strong>
            </span>
            <span
              title="What a per-member sequential gate would have cost against the same member count"
            >
              Sequential would have cost:{" "}
              <strong className="font-medium text-gray-800 dark:text-gray-100">
                {formatDuration(stats.sequentialCounterfactualMs)}
              </strong>
            </span>
            {stats.culpritCount > 0 && (
              <span className="text-red-600 dark:text-red-400">
                Culprits: <strong className="font-medium">{stats.culpritCount}</strong>
              </span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {!row && !error && (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">Loading…</div>
          )}
          {row && roots.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              No attempts recorded yet.
            </div>
          )}
          {roots.map((root) => (
            <TreeNode key={root.attempt.label} node={root} highlighted={highlighted} />
          ))}
        </div>
      </div>
    </div>
  );
}
