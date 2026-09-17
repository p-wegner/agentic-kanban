import { useEffect, useMemo, useState } from "react";
import { apiPost } from "../lib/api.js";
import { fetchMergeTrains } from "../lib/mergeTrainApi.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import {
  collectConflictClusters,
  describeTrainMembers,
  formatMergeTrainSummaryLabels,
  summarizeMergeTrains,
  type MergeTrainRowDto,
  type MergeTrainSidingDto,
  type TrainAttemptView,
  describeTrainAttempts,
  describeTrainReview,
  formatDurationShort,
  type TrainMemberOutcome,
} from "../lib/mergeTrainSummary.js";
import { fetchMergeTrainWindow } from "../lib/mergeTrainApi.js";
import {
  buildDepartureBoardRow,
  buildHistoryStrip,
  formatCountdown,
  holdReasonLabel,
  type DepartureBoardWindowDto,
} from "../lib/departureBoard.js";
import type { IssueWithStatus, MainWorkspaceInfo, StatusWithIssues } from "@agentic-kanban/shared";
import { Icon } from "./Icon.js";
import { MergeTrainDetailDrawer } from "./MergeTrainDetailDrawer.js";

interface ConflictPreview {
  workspaceId: string;
  hasConflicts: boolean;
  conflictingFiles: string[];
  isStale: boolean;
  error?: string;
}

export interface MergeQueueItem {
  issue: IssueWithStatus;
  workspace: MainWorkspaceInfo;
  readyForMerge: boolean;
  ageSource: string | null;
  conflictRisk: number;
  riskLabel: "blocked" | "high" | "medium" | "low";
}

interface MergeQueuePanelProps {
  columns: StatusWithIssues[];
  projectId: string;
  onClose: () => void;
  onIssueClick: (issue: IssueWithStatus) => void;
  onMerged?: () => void;
}

function riskLabel(score: number): MergeQueueItem["riskLabel"] {
  if (score >= 1000) return "blocked";
  if (score >= 80) return "high";
  if (score >= 20) return "medium";
  return "low";
}

export function computeMergeConflictRisk(workspace: MainWorkspaceInfo): number {
  const conflicts = workspace.conflicts;
  if (conflicts?.hasConflicts) {
    return 1000 + conflicts.conflictingFiles.length * 100;
  }

  const stats = workspace.diffStats;
  if (!stats) return 0;

  const lineChurn = stats.insertions + stats.deletions;
  return stats.filesChanged * 6 + Math.ceil(lineChurn / 50);
}

export function buildMergeQueueItems(columns: StatusWithIssues[]): MergeQueueItem[] {
  const seen = new Set<string>();
  const inReview = columns.find((column) => column.name === "In Review");
  if (!inReview) return [];

  return inReview.issues
    .flatMap((issue) => {
      const workspace = issue.workspaceSummary?.main;
      if (!workspace || seen.has(workspace.id) || workspace.status === "closed") return [];
      seen.add(workspace.id);

      const conflictRisk = computeMergeConflictRisk(workspace);
      return [{
        issue,
        workspace,
        readyForMerge: workspace.readyForMerge === true,
        ageSource: workspace.lastSessionAt ?? issue.statusChangedAt ?? issue.updatedAt,
        conflictRisk,
        riskLabel: riskLabel(conflictRisk),
      }];
    })
    .sort((a, b) => {
      if (a.readyForMerge !== b.readyForMerge) return a.readyForMerge ? -1 : 1;
      if (a.conflictRisk !== b.conflictRisk) return a.conflictRisk - b.conflictRisk;
      const ageA = a.ageSource ? new Date(a.ageSource).getTime() : Number.POSITIVE_INFINITY;
      const ageB = b.ageSource ? new Date(b.ageSource).getTime() : Number.POSITIVE_INFINITY;
      return ageA - ageB;
    });
}

function formatDiffStats(workspace: MainWorkspaceInfo): string {
  const stats = workspace.diffStats;
  if (!stats || stats.filesChanged === 0) return "No cached diff";
  const files = `${stats.filesChanged} file${stats.filesChanged === 1 ? "" : "s"}`;
  return `${files}, +${stats.insertions} / -${stats.deletions}`;
}

function riskClasses(label: MergeQueueItem["riskLabel"]): string {
  switch (label) {
    case "blocked":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "high":
      return "bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300";
    case "medium":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "low":
    default:
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
  }
}

type MergeQueueStrategy = "auto" | "sequential" | "train";

/** While a train is in flight, poll its history often enough that the bar tracks a gate landing. */
const ABOARD_POLL_INTERVAL_MS = 5000;

function trainStateBadgeClasses(state: string): string {
  switch (state) {
    case "landed":
      return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
    case "red":
      return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "abandoned":
      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
    default:
      return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * "Merge train" panel (#906, headline metric #1184) — gate-runs-per-landed / aboard / finished /
 * last gate / red-debt delta, reachable from the merge-queue view. Reads the persisted
 * `merge_trains` history instead of the old per-request scratch state, so it survives a server
 * restart mid-train. Polls while a train is assembling/gating/landing so the bar does not go
 * stale for the whole run (#1184).
 */
/** What a member chip says beside its label (#1197); `title` carries the full reason. */
function trainOutcomeLabel(outcome: TrainMemberOutcome): string {
  switch (outcome) {
    case "landed": return "landed";
    case "deferred": return "deferred → next train";
    case "dropped": return "dropped · rebase needed";
    case "gate_rejected": return "gate red";
    case "sided": return "sent back for review";
    case "aboard": return "aboard";
    case "unresolved":
    default: return "unresolved";
  }
}

function trainOutcomeClasses(outcome: TrainMemberOutcome): string {
  switch (outcome) {
    case "landed": return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
    case "deferred": return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "dropped":
    case "gate_rejected": return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "sided": return "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300";
    case "aboard": return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
    case "unresolved":
    default: return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  }
}

/** #1198: a bisect node's colour by verdict; `sided` is the review's call (#1194), not a red gate. */
function trainAttemptClasses(verdict: TrainAttemptView["verdict"]): string {
  switch (verdict) {
    case "landed": return "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300";
    case "red": return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
    case "sided": return "bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300";
    case "assembly_empty":
    case "land_refused":
    case "env_failure":
    default: return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  }
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  const suffix = rem10 === 1 && rem100 !== 11 ? "st" : rem10 === 2 && rem100 !== 12 ? "nd" : rem10 === 3 && rem100 !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** The train-conflicts group scan's answer, as the panel shows it (#1197). Inline shape: the server's `TicketGroupScanResult` is the one declaration. */
type GroupScanView = { proposals: Array<{ issueNumbers: number[]; rationale: string }>; rejected: Array<{ issueNumbers: number[]; reason: string }>; scannedCount: number; createdEdges?: number };

function MergeTrainSummaryBar({ projectId, memberLabel, onOpenTrain }: { projectId: string; memberLabel: (workspaceId: string) => string; onOpenTrain: (trainId: string) => void }) {
  const [trains, setTrains] = useState<MergeTrainRowDto[] | null>(null);
  // #1198: the project's live sidings (#1192), delivered beside the history by the same call.
  const [sidings, setSidings] = useState<MergeTrainSidingDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  // #1197: the train-conflicts group scan, previewed first and applied on a second click —
  // `apply` writes `coupled_with` edges, which is an operator's call, not a side effect of looking.
  const [scan, setScan] = useState<{ result: GroupScanView; applied: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const runScan = async (apply: boolean) => {
    setScanning(true);
    setScanError(null);
    try {
      const result = await apiPost<GroupScanView>("/api/issues/group-scan", { projectId, mode: "train-conflicts", apply });
      setScan({ result, applied: apply });
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Group scan failed");
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      try {
        const result = await fetchMergeTrains(projectId);
        if (cancelled) return;
        setTrains(result.trains);
        setSidings(Array.isArray(result.sidings) ? result.sidings : []);
        setError(null);
        const stillAboard = result.trains.some((t) => t.state === "assembling" || t.state === "gating" || t.state === "landing");
        if (stillAboard) timer = setTimeout(load, ABOARD_POLL_INTERVAL_MS);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load merge train history");
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  if (error) {
    return (
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs text-red-600 dark:text-red-400">
        Merge train: {error}
      </div>
    );
  }

  if (!trains) {
    return (
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
        Merge train: loading…
      </div>
    );
  }

  const summary = summarizeMergeTrains(trains);
  const { aboardLabel, lastGateLabel, headlineLabel } = formatMergeTrainSummaryLabels(summary);
  const { gateRunsPerLanded } = summary;

  // #1197: the newest train's members with how each fared, and the member-vs-member conflict
  // clusters (#1191) the train-conflicts group scan would turn into coupled_with proposals.
  const latest = summary.lastGate ? trains.find((t) => t.id === summary.lastGate?.trainId) ?? null : null;
  const members = latest ? describeTrainMembers(latest, sidings) : [];
  const clusters = collectConflictClusters(trains);
  // #1198: the train review's verdict (#1194) and the bisect tree with its concurrent-gate
  // overlap (#1193) — data three branches persisted that nothing drew.
  const review = latest ? describeTrainReview(latest) : null;
  const { attempts, savedMs } = latest ? describeTrainAttempts(latest) : { attempts: [], savedMs: 0 };
  // Members on a siding that the latest train did not carry at all (held out of its candidate set).
  const heldOut = sidings.filter((s) => !members.some((m) => m.workspaceId === s.workspaceId));

  return (
    <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 space-y-1 text-xs text-gray-600 dark:text-gray-300">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-[11px]">Merge train</span>
        <span
          title={`Gate runs spent per member landed, over the last ${gateRunsPerLanded.windowSize} finished train(s). A train's whole promise is 1 gate run for the batch — this shows whether that held.`}
        >
          Gate runs/landed: <strong className="font-medium text-gray-800 dark:text-gray-100">{headlineLabel}</strong>
        </span>
        <span>Aboard: <strong className="font-medium text-gray-800 dark:text-gray-100">{aboardLabel}</strong></span>
        <span>Finished: <strong className="font-medium text-gray-800 dark:text-gray-100">{summary.finishedCount}</strong></span>
        <span>
          Last gate:{" "}
          {summary.lastGate ? (
            <button
              type="button"
              onClick={() => onOpenTrain(summary.lastGate!.trainId)}
              className="font-medium text-blue-700 dark:text-blue-300 underline decoration-dotted hover:decoration-solid"
              title="Open the bisect tree for this train"
            >
              {lastGateLabel}
            </button>
          ) : (
            <strong className="font-medium text-gray-800 dark:text-gray-100">{lastGateLabel}</strong>
          )}
        </span>
        <span
          className={summary.redDebtDelta > 0 ? "text-red-600 dark:text-red-400" : "text-gray-600 dark:text-gray-300"}
          title="Unique members dropped or gate-rejected minus unique members landed, across the last 10 finished trains"
        >
          Red-debt Δ: <strong className="font-medium">{summary.redDebtDelta > 0 ? `+${summary.redDebtDelta}` : summary.redDebtDelta}</strong>
        </span>
      </div>

      {latest && members.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="merge-train-members">
          <span className="text-gray-500 dark:text-gray-400">Latest <span className="font-mono">{latest.label}</span> ({latest.state}):</span>
          {members.map((m) => (
            <span
              key={m.workspaceId}
              title={m.reason ?? undefined}
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${trainOutcomeClasses(m.outcome)}`}
            >
              <span className="font-medium">{memberLabel(m.workspaceId)}</span>
              <span className="opacity-80">{trainOutcomeLabel(m.outcome)}</span>
              {m.siding && (
                <span
                  className="rounded bg-white/60 dark:bg-black/30 px-1 font-medium"
                  title={m.siding.capped
                    ? `Rebase siding capped after ${m.siding.attempts} attempts — withheld from trains until the branch moves (#1192)`
                    : `On its ${ordinal(m.siding.attempts)} rebase siding — held out of trains until the branch tip moves (#1192)`}
                >
                  {m.siding.capped ? `siding capped (${m.siding.attempts})` : `siding ${m.siding.attempts}`}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {latest && review && (
        <div className="flex flex-wrap items-center gap-x-2" data-testid="merge-train-review">
          <span className="text-gray-500 dark:text-gray-400">Train review:</span>
          <span className={review.blocking ? "font-medium text-purple-700 dark:text-purple-300" : "text-gray-800 dark:text-gray-100"}>
            {review.text}{review.blocking ? " (blocking)" : ""}
          </span>
        </div>
      )}

      {latest && attempts.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="merge-train-attempts">
          <span className="text-gray-500 dark:text-gray-400" title="Each assemble → gate → land cycle; ∥ marks halves whose gates ran at the same time (#1193)">
            Bisect ({attempts.length} attempts{savedMs > 0 ? `, gated concurrently saved ${formatDurationShort(savedMs)}` : ""}):
          </span>
          {attempts.map((a) => (
            <span
              key={a.label}
              title={[a.failureHead, a.gateMs != null ? `gate ${formatDurationShort(a.gateMs)}` : null].filter(Boolean).join(" · ") || undefined}
              className={`rounded px-1.5 py-0.5 font-mono ${trainAttemptClasses(a.verdict)}`}
            >
              {a.label} {a.verdict}{a.includedCount > 0 ? ` ×${a.includedCount}` : ""}{a.concurrentWith.length > 0 ? ` ∥ ${a.concurrentWith.join(", ")}` : ""}
            </span>
          ))}
        </div>
      )}

      {heldOut.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="merge-train-held-out">
          <span className="text-gray-500 dark:text-gray-400" title="Members on a rebase siding (#1192): dropped for a base conflict earlier, held out of trains until their branch tip moves">
            Held out on sidings:
          </span>
          {heldOut.map((s) => (
            <span key={s.workspaceId} className={`rounded px-1.5 py-0.5 ${s.cappedAt ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"}`}>
              <span className="font-medium">{memberLabel(s.workspaceId)}</span>{" "}
              {s.cappedAt ? `capped after ${s.sidings}` : `siding ${s.sidings}`}
            </span>
          ))}
        </div>
      )}

      {clusters.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="merge-train-conflict-clusters">
          <span className="text-gray-500 dark:text-gray-400" title="Members that conflicted with EACH OTHER (not with the base) on recent trains — the input to the train-conflicts group scan">
            Conflict clusters (last 10 trains):
          </span>
          {clusters.map((c) => (
            <span key={`${c.trainId}:${c.workspaceIds.join(",")}`} title={`recorded on ${c.trainLabel}`} className="font-medium text-gray-800 dark:text-gray-100">
              {c.workspaceIds.map(memberLabel).join(" ↔ ")}
            </span>
          ))}
          {scan === null || scan.applied ? (
            <button
              type="button"
              onClick={() => void runScan(false)}
              disabled={scanning}
              className="rounded border border-gray-300 dark:border-gray-600 px-2 py-0.5 text-[11px] hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
              title="Preview the coupled_with groups these clusters would propose (nothing is written)"
            >
              {scanning ? "Scanning…" : "Propose coupled groups"}
            </button>
          ) : (
            <>
              <span>
                {scan.result.proposals.length} proposal{scan.result.proposals.length === 1 ? "" : "s"}
                {scan.result.proposals.length > 0 && (
                  <>: {scan.result.proposals.map((p) => p.issueNumbers.map((n) => `#${n}`).join(" + ")).join(", ")}</>
                )}
                {scan.result.rejected.length > 0 && ` (${scan.result.rejected.length} rejected)`}
              </span>
              {scan.result.proposals.length > 0 && (
                <button
                  type="button"
                  onClick={() => void runScan(true)}
                  disabled={scanning}
                  className="rounded border border-blue-300 dark:border-blue-700 px-2 py-0.5 text-[11px] text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                  title="Write these as coupled_with edges"
                >
                  {scanning ? "Applying…" : "Apply"}
                </button>
              )}
            </>
          )}
          {scan?.applied && (
            <span className="text-green-700 dark:text-green-300">
              {scan.result.createdEdges ?? 0} coupled_with edge{(scan.result.createdEdges ?? 0) === 1 ? "" : "s"} created
            </span>
          )}
          {scanError && <span className="text-red-600 dark:text-red-400">{scanError}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * "Departure board" (#1187) — replaces the old one-line "Merge train" summary bar with a
 * platform view: boarding cars, why-held reason, the live train (with Cancel), Depart
 * now/Hold, and a history strip. Reads `GET /api/merge-queue/window` (added by #1186, "Persist
 * and expose the merge-train batching window") for the live window plus the existing
 * `GET /api/merge-queue/trains` history for the strip. Polls on the same generic board refresh
 * cadence as the rest of this panel — no dedicated WebSocket event exists yet (#1186 tracks
 * adding one; this reads a fresh snapshot every visit/interval instead of pushing). The richer
 * per-train evidence (#1197/#1198: members, review, bisect, conflict clusters) stays in
 * `MergeTrainSummaryBar`, rendered below the platform so neither loses detail.
 */
function DepartureBoard({ projectId, memberLabel, onOpenTrain }: { projectId: string; memberLabel: (workspaceId: string) => string; onOpenTrain: (trainId: string) => void }) {
  const [windowDto, setWindowDto] = useState<DepartureBoardWindowDto | null>(null);
  const [trains, setTrains] = useState<MergeTrainRowDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<"depart" | "hold" | "cancel" | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchMergeTrainWindow(projectId),
      fetchMergeTrains(projectId),
    ])
      .then(([windowResult, trainsResult]) => {
        if (cancelled) return;
        setWindowDto(windowResult.window as unknown as DepartureBoardWindowDto | null);
        setTrains(trainsResult.trains);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load departure board");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleDepartNow() {
    setActionPending("depart");
    setActionError(null);
    try {
      await apiPost(`/api/merge-queue/window/release?projectId=${encodeURIComponent(projectId)}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Depart now failed");
    } finally {
      setActionPending(null);
    }
  }

  async function handleHold() {
    setActionPending("hold");
    setActionError(null);
    try {
      await apiPost(`/api/merge-queue/window/hold?projectId=${encodeURIComponent(projectId)}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Hold failed");
    } finally {
      setActionPending(null);
    }
  }

  async function handleCancelTrain(trainId: string) {
    setActionPending("cancel");
    setActionError(null);
    try {
      await apiPost(`/api/merge-queue/trains/${trainId}/cancel`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActionPending(null);
    }
  }

  if (error) {
    return (
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs text-red-600 dark:text-red-400">
        Departure board: {error}
      </div>
    );
  }

  if (!windowDto || !trains) {
    return (
      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 text-xs text-gray-400 dark:text-gray-500">
        Departure board: loading…
      </div>
    );
  }

  const row = buildDepartureBoardRow(windowDto, nowMs);
  const history = buildHistoryStrip(trains);

  return (
    <div className="border-b border-gray-100 dark:border-gray-800">
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide text-[11px]">Departure board</span>
        {row.trigger && !row.liveTrain && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Departs on <strong className="font-medium text-gray-800 dark:text-gray-100">{row.trigger === "max_size" ? "size" : "max wait"}</strong>{" "}
            in <strong className="font-mono text-gray-800 dark:text-gray-100">{formatCountdown(row.msUntilDeparture)}</strong>
          </span>
        )}
      </div>

      {actionError && (
        <div className="px-4 pb-2 text-xs text-red-600 dark:text-red-400">{actionError}</div>
      )}

      {row.liveTrain ? (
        <div className="px-4 pb-3">
          <div className="rounded border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 px-3 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-blue-800 dark:text-blue-200">
                Live train: {row.liveTrain.label} — {row.liveTrain.state}
              </div>
              <div className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                Elapsed {formatRelativeTime(row.liveTrain.startedAt)} · {row.liveTrain.memberCount} member{row.liveTrain.memberCount === 1 ? "" : "s"} · {row.liveTrain.gateRuns} gate run{row.liveTrain.gateRuns === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleCancelTrain(row.liveTrain!.id)}
              disabled={actionPending !== null}
              className="text-xs px-2.5 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {actionPending === "cancel" ? "Cancelling..." : "Cancel"}
            </button>
          </div>
        </div>
      ) : row.boarding.length > 0 ? (
        <div className="px-4 pb-3 space-y-2">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            Why held: <strong className="font-medium text-gray-800 dark:text-gray-100">{holdReasonLabel(row.holdReason, row.liveTrain)}</strong>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {row.boarding.map((car) => (
              <span
                key={car.workspaceId}
                className="text-xs px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-mono"
                title={`Ready since ${formatRelativeTime(car.readySince)}`}
              >
                #{car.issueNumber} {car.title}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleDepartNow()}
              disabled={actionPending !== null}
              className="text-xs px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionPending === "depart" ? "Departing..." : "Depart now"}
            </button>
            <button
              type="button"
              onClick={() => void handleHold()}
              disabled={actionPending !== null}
              className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionPending === "hold" ? "Holding..." : "Hold"}
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-3 text-xs text-gray-400 dark:text-gray-500">No tickets are boarding.</div>
      )}

      {history.length > 0 && (
        <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto">
          {history.map((tile) => (
            <button
              key={tile.id}
              type="button"
              onClick={() => onOpenTrain(tile.id)}
              title={`${tile.state} · ${tile.memberCount} member${tile.memberCount === 1 ? "" : "s"} · ${tile.gateRuns ?? "?"} gate run${tile.gateRuns === 1 ? "" : "s"} · ${formatDuration(tile.durationMs)}`}
              className={`shrink-0 text-[11px] px-2 py-1 rounded font-medium ${trainStateBadgeClasses(tile.state)} hover:opacity-80`}
            >
              {tile.state} · {tile.memberCount}m
            </button>
          ))}
        </div>
      )}

      <MergeTrainSummaryBar projectId={projectId} memberLabel={memberLabel} onOpenTrain={onOpenTrain} />
    </div>
  );
}

export function MergeQueuePanel({ columns, projectId, onClose, onIssueClick, onMerged }: MergeQueuePanelProps) {
  const items = useMemo(() => buildMergeQueueItems(columns), [columns]);
  // #1197: the train evidence names members by WORKSPACE id; the board knows them by ticket.
  // A member that has since landed is no longer in the queue, so its id is shown shortened.
  const memberLabel = useMemo(() => {
    const byWorkspace = new Map(items.map((item) => [
      item.workspace.id,
      item.issue.issueNumber != null ? `#${item.issue.issueNumber}` : item.issue.title.slice(0, 24),
    ]));
    return (workspaceId: string) => byWorkspace.get(workspaceId) ?? workspaceId.slice(0, 8);
  }, [items]);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [errorByWorkspace, setErrorByWorkspace] = useState<Record<string, string>>({});
  const [previewByWorkspace, setPreviewByWorkspace] = useState<Record<string, ConflictPreview>>({});
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  // #904 — "auto" omits `strategy` on the wire so the server decides (classifier recommendation
  // or the project's train_max_size opt-in); the other two are explicit overrides.
  const [strategy, setStrategy] = useState<MergeQueueStrategy>("auto");
  // #1187/#1189 — both the departure-board history tiles and the merge-train summary's
  // "Last gate" figure open the same drawer, keyed by train id.
  const [openTrainId, setOpenTrainId] = useState<string | null>(null);

  async function handleMerge(workspaceId: string) {
    const confirmed = window.confirm("Trigger merge for this workspace?");
    if (!confirmed) return;

    setMergingId(workspaceId);
    setErrorByWorkspace((prev) => {
      const next = { ...prev };
      delete next[workspaceId];
      return next;
    });

    try {
      await apiPost(`/api/workspaces/${workspaceId}/merge`);
      onMerged?.();
    } catch (err) {
      setErrorByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: err instanceof Error ? err.message : "Merge failed",
      }));
    } finally {
      setMergingId(null);
    }
  }

  async function handleCheckConflicts(workspaceId: string) {
    setCheckingId(workspaceId);
    try {
      const result = await apiPost<{ ok: boolean; preview: ConflictPreview }>(`/api/merge-queue/preview/${workspaceId}`);
      setPreviewByWorkspace((prev) => ({ ...prev, [workspaceId]: result.preview }));
    } catch (err) {
      setPreviewByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: {
          workspaceId,
          hasConflicts: false,
          conflictingFiles: [],
          isStale: false,
          error: err instanceof Error ? err.message : "Check failed",
        },
      }));
    } finally {
      setCheckingId(null);
    }
  }

  async function handleCheckAll() {
    const workspaceIds = items.map((item) => item.workspace.id);
    if (workspaceIds.length === 0) return;
    setCheckingAll(true);
    try {
      const result = await apiPost<{ ok: boolean; dryRun: boolean; plan: { conflictPreviews: ConflictPreview[] } }>("/api/merge-queue", {
        workspaceIds,
        dryRun: true,
        ...(strategy === "auto" ? {} : { strategy }),
      });
      const map: Record<string, ConflictPreview> = {};
      for (const preview of result.plan.conflictPreviews) {
        map[preview.workspaceId] = preview;
      }
      setPreviewByWorkspace((prev) => ({ ...prev, ...map }));
    } catch {
      // best effort — individual errors will surface on per-workspace retry
    } finally {
      setCheckingAll(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[min(720px,100vw)] bg-surface-raised dark:bg-surface-raised-dark shadow-xl flex flex-col animate-slide-in-right">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-orange-600">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h12M3 17h6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l3 3-3 3" />
            </Icon>
            <h2 className="text-lg font-semibold text-ink dark:text-stone-100 heading-serif">Merge Queue</h2>
            <span className="text-sm text-gray-500 dark:text-gray-400">({items.length})</span>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as MergeQueueStrategy)}
                className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-transparent text-gray-600 dark:text-gray-300"
                title="Merge queue strategy used by Check All (this panel has no batch-execute action; per-row Merge is unaffected)"
                aria-label="Merge queue strategy"
              >
                <option value="auto">Strategy: Auto</option>
                <option value="train">Strategy: Train</option>
                <option value="sequential">Strategy: Sequential</option>
              </select>
            )}
            {items.length > 0 && (
              <button
                type="button"
                onClick={() => void handleCheckAll()}
                disabled={checkingAll || checkingId !== null}
                className="text-xs px-2.5 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Check all workspaces for merge conflicts (read-only)"
              >
                {checkingAll ? "Checking..." : "Check All"}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
              aria-label="Close merge queue"
            >
              &times;
            </button>
          </div>
        </div>

        <DepartureBoard projectId={projectId} memberLabel={memberLabel} onOpenTrain={setOpenTrainId} />

        <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <span>Workspace</span>
          <span>Ready</span>
          <span>Risk</span>
          <span>Age</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              No In Review workspaces are waiting in the merge queue.
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {items.map((item, index) => {
                const { issue, workspace } = item;
                const mergeError = errorByWorkspace[workspace.id];
                const isMerging = mergingId === workspace.id;
                const isChecking = checkingId === workspace.id;
                const conflicts = workspace.conflicts?.hasConflicts ? workspace.conflicts.conflictingFiles : [];
                const preview = previewByWorkspace[workspace.id];

                return (
                  <div key={workspace.id} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800">
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-start">
                      <button
                        type="button"
                        onClick={() => {
                          onIssueClick(issue);
                          onClose();
                        }}
                        className="min-w-0 text-left"
                        title="Open workspace detail"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">{index + 1}</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500 font-mono shrink-0">#{issue.issueNumber}</span>
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{issue.title}</span>
                        </div>
                        <div className="mt-1 ml-10 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[260px]">{workspace.branch}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{formatDiffStats(workspace)}</span>
                          <span className="text-xs text-gray-400 dark:text-gray-500">{workspace.status}</span>
                        </div>
                      </button>

                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${item.readyForMerge ? "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                        {item.readyForMerge ? "Ready" : "Gated"}
                      </span>

                      <span
                        className={`text-xs px-2 py-1 rounded-full font-medium ${riskClasses(item.riskLabel)}`}
                        title={conflicts.length > 0 ? `Conflicts: ${conflicts.join(", ")}` : `Risk score: ${item.conflictRisk}`}
                      >
                        {item.riskLabel === "blocked" ? "Conflicts" : `${item.riskLabel} ${item.conflictRisk}`}
                      </span>

                      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap pt-1">
                        {item.ageSource ? formatRelativeTime(item.ageSource) : "unknown"}
                      </span>
                    </div>

                    {conflicts.length > 0 && !preview && (
                      <div className="mt-2 ml-10 text-xs text-red-600 dark:text-red-400 font-mono truncate">
                        {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}: {conflicts.join(", ")}
                      </div>
                    )}

                    {preview && (
                      <div className="mt-2 ml-10 space-y-0.5">
                        {preview.error ? (
                          <div className="text-xs text-red-600 dark:text-red-400">Check error: {preview.error}</div>
                        ) : preview.hasConflicts ? (
                          <div className="text-xs text-red-600 dark:text-red-400 font-mono">
                            {preview.conflictingFiles.length} conflict{preview.conflictingFiles.length === 1 ? "" : "s"}: {preview.conflictingFiles.join(", ")}
                          </div>
                        ) : (
                          <div className="text-xs text-green-600 dark:text-green-400">No conflicts detected</div>
                        )}
                        {preview.isStale && (
                          <div className="text-xs text-amber-600 dark:text-amber-400">Base branch has new commits — consider rebasing</div>
                        )}
                      </div>
                    )}

                    {mergeError && (
                      <div className="mt-2 ml-10 text-xs text-red-600 dark:text-red-400">
                        {mergeError}
                      </div>
                    )}

                    <div className="mt-2 ml-10 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          onIssueClick(issue);
                          onClose();
                        }}
                        className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                      >
                        Open Detail
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCheckConflicts(workspace.id)}
                        disabled={isChecking || checkingAll || checkingId !== null}
                        className="text-xs px-2.5 py-1 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Dry-run conflict check (read-only)"
                      >
                        {isChecking ? "Checking..." : "Check"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleMerge(workspace.id)}
                        disabled={isMerging || mergingId !== null}
                        className="text-xs px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={item.readyForMerge ? "Trigger existing merge endpoint" : "Trigger existing merge endpoint for a gated item"}
                      >
                        {isMerging ? "Merging..." : "Merge"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {openTrainId && (
        <MergeTrainDetailDrawer
          projectId={projectId}
          trainId={openTrainId}
          onClose={() => setOpenTrainId(null)}
        />
      )}
    </div>
  );
}
