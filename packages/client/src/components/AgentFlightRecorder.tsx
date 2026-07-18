import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";
import { getAgentQuestions } from "../lib/agentQuestionsStore.js";
import { useAgentActivityStore } from "../stores/agentActivityStore.js";
import { detectAgentStall } from "../lib/detectAgentStall.js";
import { useAgentStallThreshold } from "./AgentStallBadge.js";
import { useCrossRepoActivity } from "../hooks/useCrossRepoActivity.js";
import {
  normalizeCrossRepoEntry,
  normalizeStallSignal,
  normalizeAgentQuestion,
  normalizeStatusTransition,
  mergeFlightRecorderEvents,
  filterFlightRecorderEvents,
  collectFlightRecorderFacets,
  SEVERITY_ORDER,
  type FlightRecorderEvent,
  type FlightRecorderSeverity,
  type FlightRecorderTranscriptTarget,
  type FlightRecorderFilter,
  type FlightRecorderFacets,
} from "../lib/flightRecorderEvents.js";

/** Severity → dot colour + label for the row and the filter chips. */
const SEVERITY_META: Record<FlightRecorderSeverity, { dot: string; label: string; text: string }> = {
  error: { dot: "bg-red-500", label: "error", text: "text-red-600 dark:text-red-400" },
  warn: { dot: "bg-amber-500", label: "warn", text: "text-amber-600 dark:text-amber-400" },
  info: { dot: "bg-blue-500", label: "info", text: "text-blue-600 dark:text-blue-400" },
};

/** Short kind chips so the operator can scan the class of each event. */
const KIND_LABEL: Record<FlightRecorderEvent["kind"], string> = {
  tool_error: "tool error",
  approval_request: "approval",
  agent_question: "question",
  status_transition: "status",
  phase_transition: "phase",
  stall: "stall",
  loop: "loop",
  merge: "merge",
  merge_failure: "merge failed",
  conflict: "conflict",
};

/** Slim projection of GET /api/workspaces?projectId= (see listWorkspacesSlim). */
interface SlimWorkspace {
  id: string;
  issueId: string;
  status: string;
  isDirect: boolean;
  latestSessionId?: string | null;
}

/** Non-terminal statuses worth watching — same allowlist the cross-repo feed uses. */
const NON_CLOSED_WORKSPACE_STATUSES = [
  "active", "idle", "blocked", "reviewing", "fixing", "ready_for_merge", "awaiting-plan-approval", "error",
].join(",");

/** WS reasons after which runtime state (status/questions/stall) may have moved. */
function shouldRefetch(reason: string): boolean {
  return (
    reason === "reconnect" ||
    reason === "poll" ||
    reason.startsWith("session") ||
    reason.startsWith("workflow") ||
    reason.startsWith("workspace") ||
    reason.startsWith("drive") ||
    reason.includes("merge") ||
    reason.includes("question") ||
    reason.includes("status")
  );
}

interface ResolveIssue {
  (issueId: string): { issueNumber: number | null; title?: string | null } | undefined;
}

/**
 * Live agent runtime-event sources merged into one flight-recorder timeline (#99).
 * Reuses existing streams — the cross-repo activity reducer, the agent-activity store +
 * stall detector, the pending agent-questions endpoint, and per-workspace status
 * snapshots — normalizes each into {@link FlightRecorderEvent}, and merges them. No new
 * server event infrastructure: this is a unified VIEW over what the board already emits.
 */
function useFlightRecorderEvents(projectId: string | null, resolveIssue?: ResolveIssue) {
  const { entries: crossRepoEntries } = useCrossRepoActivity(projectId, resolveIssue);
  const thresholdSec = useAgentStallThreshold();
  const activityByIssue = useAgentActivityStore((s) => s.byIssue);

  const [workspaces, setWorkspaces] = useState<SlimWorkspace[]>([]);
  const [questionEvents, setQuestionEvents] = useState<FlightRecorderEvent[]>([]);
  const [statusEvents, setStatusEvents] = useState<FlightRecorderEvent[]>([]);
  // Re-render on a slow tick so a growing idle gap crosses the stall threshold live.
  const [, setTick] = useState(0);
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const resolveRef = useRef(resolveIssue);
  resolveRef.current = resolveIssue;

  const refresh = useCallback(async () => {
    if (!projectId) return;
    // Pending agent questions → question/approval events.
    getAgentQuestions(projectId)
      .then((sets) => {
        const now = new Date().toISOString();
        setQuestionEvents(
          sets.map((set) => {
            const q = set.questions[0];
            return normalizeAgentQuestion(
              {
                toolUseId: set.toolUseId,
                workspaceId: set.workspaceId,
                sessionId: set.sessionId,
                issueId: set.issueId,
                issueNumber: set.issueNumber,
                issueTitle: set.issueTitle,
                header: q?.header ?? null,
                question: q?.question ?? null,
                questionCount: set.questions.length,
                askedAt: set.askedAt,
                isApproval: (q?.options?.length ?? 0) <= 2 && !q?.multiSelect,
                staleLabel: set.staleness?.label ?? null,
              },
              now,
            );
          }),
        );
      })
      .catch(() => { /* endpoint down — leave prior questions in place */ });

    // Active workspaces → status-transition events (diffed against the prior snapshot).
    apiFetch<SlimWorkspace[]>(`/api/workspaces?projectId=${projectId}&status=${NON_CLOSED_WORKSPACE_STATUSES}`)
      .then((ws) => {
        const now = new Date().toISOString();
        const active = ws.filter((w) => !w.isDirect);
        const fresh: FlightRecorderEvent[] = [];
        for (const w of active) {
          const from = prevStatusRef.current.get(w.id) ?? null;
          prevStatusRef.current.set(w.id, w.status);
          // First observation seeds the baseline silently; only real transitions emit.
          if (from === null || from === w.status) continue;
          const issue = resolveRef.current?.(w.issueId);
          const ev = normalizeStatusTransition({
            workspaceId: w.id,
            issueId: w.issueId,
            issueNumber: issue?.issueNumber ?? null,
            issueTitle: issue?.title ?? null,
            sessionId: w.latestSessionId ?? null,
            from,
            to: w.status,
            at: now,
          });
          if (ev) fresh.push(ev);
        }
        setWorkspaces(active);
        // Accumulate status transitions (capped) so the timeline retains recent history.
        if (fresh.length > 0) setStatusEvents((prev) => mergeFlightRecorderEvents([fresh, prev], 100));
      })
      .catch(() => { /* server down — keep prior snapshot */ });
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    prevStatusRef.current = new Map();
    setQuestionEvents([]);
    setStatusEvents([]);
    void refresh();
    const onWs = (ev: Event) => {
      const detail = (ev as CustomEvent<BoardWsEventDetail>).detail;
      if (!detail || detail.projectId !== projectId) return;
      if (shouldRefetch(detail.reason)) void refresh();
    };
    window.addEventListener(BOARD_WS_EVENT, onWs);
    const tick = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => {
      window.removeEventListener(BOARD_WS_EVENT, onWs);
      clearInterval(tick);
    };
  }, [projectId, refresh]);

  // Stall/loop events derived from the live activity store + the active workspaces. Kept
  // in a memo (not fetched) so it re-computes on every store change and idle tick.
  const stallEvents = useMemo<FlightRecorderEvent[]>(() => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const out: FlightRecorderEvent[] = [];
    for (const w of workspaces) {
      const meta = activityByIssue[w.issueId];
      const signal = detectAgentStall({
        status: w.status,
        lastActivityAt: meta?.lastActivityAt ?? null,
        recentTools: meta?.recentTools,
        thresholdSec,
        now,
      });
      const issue = resolveRef.current?.(w.issueId);
      const ev = normalizeStallSignal({
        workspaceId: w.id,
        issueId: w.issueId,
        issueNumber: issue?.issueNumber ?? null,
        issueTitle: issue?.title ?? null,
        sessionId: w.latestSessionId ?? null,
        signal,
        at: nowIso,
      });
      if (ev) out.push(ev);
    }
    return out;
  }, [workspaces, activityByIssue, thresholdSec]);

  const events = useMemo(
    () =>
      mergeFlightRecorderEvents([
        crossRepoEntries.map(normalizeCrossRepoEntry),
        stallEvents,
        questionEvents,
        statusEvents,
      ]),
    [crossRepoEntries, stallEvents, questionEvents, statusEvents],
  );

  return { events, refresh };
}

interface AgentFlightRecorderViewProps {
  /** Events to display (already filtered). */
  events: readonly FlightRecorderEvent[];
  /** Total (pre-filter) count, for the "N of M" header. */
  totalCount: number;
  facets: FlightRecorderFacets;
  filter: FlightRecorderFilter;
  onFilterChange: (next: FlightRecorderFilter) => void;
  onJump?: (target: FlightRecorderTranscriptTarget) => void;
  onRefresh?: () => void;
}

/**
 * Presentational flight-recorder: filter controls (workspace / repo / severity) atop a
 * chronological, severity-coded list of runtime events, each with a jump-to-transcript
 * link. Pure over its props — see {@link useFlightRecorderEvents} for the live wiring.
 */
export function AgentFlightRecorderView({
  events, totalCount, facets, filter, onFilterChange, onJump, onRefresh,
}: AgentFlightRecorderViewProps) {
  return (
    <div className="flex flex-col h-full overflow-hidden p-4" data-testid="agent-flight-recorder">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Agent Flight Recorder</h2>
          <p className="text-[11px] text-gray-400 dark:text-gray-500">
            Live runtime events across all active workspaces
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 dark:text-gray-500" data-testid="flight-recorder-count">
            {events.length} of {totalCount} event{totalCount !== 1 ? "s" : ""}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Refresh"
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1 rounded"
            >
              ↻
            </button>
          )}
        </div>
      </div>

      {/* Filters: workspace, repo, severity. */}
      <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="flight-recorder-filters">
        <select
          data-testid="filter-workspace"
          aria-label="Filter by workspace"
          value={filter.workspaceId ?? ""}
          onChange={(e) => onFilterChange({ ...filter, workspaceId: e.target.value || null })}
          className="text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-gray-700 dark:text-gray-300"
        >
          <option value="">All workspaces</option>
          {facets.workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.label}</option>
          ))}
        </select>
        <select
          data-testid="filter-repo"
          aria-label="Filter by repo"
          value={filter.repo ?? ""}
          onChange={(e) => onFilterChange({ ...filter, repo: e.target.value || null })}
          disabled={facets.repos.length === 0}
          className="text-xs rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-gray-700 dark:text-gray-300 disabled:opacity-40"
        >
          <option value="">All repos</option>
          {facets.repos.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <div className="flex items-center gap-1" role="group" aria-label="Filter by severity">
          {SEVERITY_ORDER.map((sev) => {
            const active = filter.severity === sev;
            return (
              <button
                key={sev}
                type="button"
                data-testid={`filter-severity-${sev}`}
                aria-pressed={active}
                onClick={() => onFilterChange({ ...filter, severity: active ? null : sev })}
                className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full border transition-colors ${
                  active
                    ? "border-gray-400 dark:border-gray-500 bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-100"
                    : "border-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${SEVERITY_META[sev].dot}`} />
                {SEVERITY_META[sev].label}
              </button>
            );
          })}
        </div>
      </div>

      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-2 text-center" data-testid="flight-recorder-empty">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          <p className="text-sm text-gray-400 dark:text-gray-500">
            {totalCount === 0 ? "No runtime events yet." : "No events match the current filters."}
          </p>
          <p className="text-xs text-gray-300 dark:text-gray-600">
            Tool errors, agent questions, stalls, status changes, and merges appear here live.
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto space-y-0" data-testid="flight-recorder-list">
          {events.map((ev) => {
            const meta = SEVERITY_META[ev.severity];
            return (
              <li
                key={ev.id}
                data-testid="flight-recorder-row"
                data-severity={ev.severity}
                data-kind={ev.kind}
                className="flex items-start gap-2 py-2 px-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800/50 group"
              >
                <span className={`shrink-0 mt-1.5 h-2 w-2 rounded-full ${meta.dot}`} title={meta.label} />
                {ev.repo && (
                  <span
                    className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                    title={`Repo: ${ev.repo}`}
                  >
                    {ev.repo}
                  </span>
                )}
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  {KIND_LABEL[ev.kind]}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="text-xs text-gray-700 dark:text-gray-300 leading-snug break-words">
                    {ev.summary}
                  </span>
                  {ev.transcript && onJump && (
                    <button
                      type="button"
                      data-testid="flight-recorder-jump"
                      onClick={() => onJump(ev.transcript!)}
                      className="block mt-0.5 text-[11px] text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 hover:underline text-left"
                    >
                      {ev.workspaceLabel ? `${ev.workspaceLabel} · ` : ""}jump to transcript
                    </button>
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums pt-0.5" title={ev.timestamp}>
                  {formatRelativeTime(ev.timestamp)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface AgentFlightRecorderProps {
  projectId: string;
  /** Resolve an issue's number/title for entry labels (built from the board columns). */
  resolveIssue?: ResolveIssue;
  /** Open the workspace transcript for a jumped-to event. */
  onJumpToTranscript?: (target: FlightRecorderTranscriptTarget) => void;
}

/**
 * Agent Event Flight-Recorder (#99): a live, filterable stream merging high-signal
 * agent-runtime events (tool errors, approval requests / agent questions, status
 * transitions, stall/loop detections, merges / merge-failures / conflicts) across every
 * active workspace and repo, with a jump-to-transcript link per entry. Read-only unified
 * view over existing streams.
 */
export function AgentFlightRecorder({ projectId, resolveIssue, onJumpToTranscript }: AgentFlightRecorderProps) {
  const { events, refresh } = useFlightRecorderEvents(projectId, resolveIssue);
  const [filter, setFilter] = useState<FlightRecorderFilter>({});

  const facets = useMemo(() => collectFlightRecorderFacets(events), [events]);
  const filtered = useMemo(() => filterFlightRecorderEvents(events, filter), [events, filter]);

  return (
    <AgentFlightRecorderView
      events={filtered}
      totalCount={events.length}
      facets={facets}
      filter={filter}
      onFilterChange={setFilter}
      onJump={onJumpToTranscript}
      onRefresh={refresh}
    />
  );
}
