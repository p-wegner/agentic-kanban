/**
 * Pending agent questions panel — surfaces AskUserQuestion permission denials
 * captured from completed sessions and lets the user answer them. Each card
 * represents one denied AskUserQuestion ask (which can contain multiple sub-
 * questions). Submitting POSTs the formatted answer as a follow-up turn to the
 * blocked workspace and marks the ask answered server-side.
 *
 * Rendered inline above the Butler chat so the user gets one place to clear
 * agent-blocking questions.
 */
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestionRecommendation {
  recommendedOptionIndexes: number[];
  freeText?: string;
  rationale: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentQuestionOption[];
  /** Butler-recommended answer. undefined = not yet computed; null = failed (graceful degrade). */
  recommendation?: AgentQuestionRecommendation | null;
}

export type StalenessReason =
  | "workspace-merged"
  | "issue-done"
  | "superseded"
  | "older-than-24h";

export interface Staleness {
  reason: StalenessReason;
  /** Human-readable label, e.g. "stale — workspace merged". */
  label: string;
  /** Relevant timestamp for the tooltip. */
  at: string | null;
}

export interface PendingQuestionSet {
  toolUseId: string;
  workspaceId: string;
  sessionId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  questions: AgentQuestion[];
  askedAt: string | null;
  /** Set when the question is likely no longer actionable; null/undefined when fresh. */
  staleness?: Staleness | null;
}

interface Props {
  projectId: string;
  /** Notifies parent (Board) when the count changes, so the nav badge updates. */
  onCountChange?: (count: number) => void;
}

interface AnswerState {
  selectedLabels: string[];
  freeText: string;
}

/** Compact "Xh ago" / "Xm ago" / "Xd ago" for the collapsed card header. */
function formatAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** One-line summary for the collapsed card header. The first question drives the
 *  summary (most asks have one); a multi-question ask appends "+N more". */
function collapsedSummary(set: PendingQuestionSet): string {
  const q = set.questions[0];
  const parts: string[] = [];
  const issueRef = set.issueNumber !== null ? `#${set.issueNumber} ${set.issueTitle}` : set.issueTitle;
  parts.push(issueRef);
  if (q?.header) parts.push(q.header);
  else if (q?.question) parts.push(q.question.length > 60 ? `${q.question.slice(0, 60)}…` : q.question);
  const rec = q?.recommendation;
  if (rec) {
    const recLabels = rec.recommendedOptionIndexes.map((i) => q.options[i]?.label).filter(Boolean);
    if (recLabels.length > 0) parts.push(`Butler recommends: "${recLabels.join(", ")}"`);
    else if (rec.freeText) parts.push(`Butler recommends: "${rec.freeText.slice(0, 40)}"`);
  }
  const optCount = q?.options.length ?? 0;
  if (optCount > 0) parts.push(`${optCount} option${optCount === 1 ? "" : "s"}`);
  if (set.questions.length > 1) parts.push(`+${set.questions.length - 1} more`);
  const ago = formatAgo(set.askedAt);
  if (ago) parts.push(ago);
  return parts.join(" · ");
}

function emptyAnswers(qs: AgentQuestion[]): AnswerState[] {
  return qs.map((q) => {
    const rec = q.recommendation;
    if (!rec) return { selectedLabels: [], freeText: "" };
    const selectedLabels: string[] = [];
    for (const idx of rec.recommendedOptionIndexes) {
      const opt = q.options[idx];
      if (opt) selectedLabels.push(opt.label);
    }
    const freeText = selectedLabels.length === 0 && rec.freeText ? rec.freeText : "";
    return { selectedLabels, freeText };
  });
}

/** Muted-gray staleness badge with a tooltip showing the exact reason + timestamp. */
function StalenessBadge({ staleness }: { staleness: Staleness }) {
  const ts = staleness.at ? new Date(staleness.at).toLocaleString() : null;
  const tooltip = ts ? `${staleness.label} (${ts})` : staleness.label;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-[10px] font-medium px-1.5 py-0.5"
      title={tooltip}
      data-testid="staleness-badge"
      data-staleness-reason={staleness.reason}
    >
      {staleness.label}
    </span>
  );
}

function QuestionCard({
  set,
  expanded,
  onToggle,
  onAnswered,
  onDismiss,
  onError,
}: {
  set: PendingQuestionSet;
  expanded: boolean;
  onToggle: () => void;
  onAnswered: () => void;
  onDismiss: () => void;
  onError: (msg: string) => void;
}) {
  const [answers, setAnswers] = useState<AnswerState[]>(() => emptyAnswers(set.questions));
  const [submitting, setSubmitting] = useState(false);
  /** Tracks whether the user has manually edited any answer for a given question — once true,
   *  we never overwrite that answer with a late-arriving butler recommendation. */
  const userEdited = useRef<boolean[]>(set.questions.map(() => false));

  // When a recommendation arrives on a later poll, apply it to questions the user
  // hasn't touched yet. Recommendations that fail (null) or are still pending (undefined)
  // are ignored — we keep whatever the user has, or the empty default.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = prev.map((a, qIdx) => {
        if (userEdited.current[qIdx]) return a;
        const q = set.questions[qIdx];
        const rec = q?.recommendation;
        if (!rec) return a;
        const selectedLabels: string[] = [];
        for (const idx of rec.recommendedOptionIndexes) {
          const opt = q.options[idx];
          if (opt) selectedLabels.push(opt.label);
        }
        const freeText = selectedLabels.length === 0 && rec.freeText ? rec.freeText : a.freeText;
        if (selectedLabels.join(" ") === a.selectedLabels.join(" ") && freeText === a.freeText) return a;
        changed = true;
        return { selectedLabels, freeText };
      });
      return changed ? next : prev;
    });
  }, [set.questions]);

  function toggleOption(qIdx: number, label: string, multi: boolean) {
    userEdited.current[qIdx] = true;
    setAnswers((prev) => {
      const next = prev.map((a) => ({ ...a, selectedLabels: [...a.selectedLabels] }));
      const cur = next[qIdx].selectedLabels;
      if (multi) {
        next[qIdx].selectedLabels = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      } else {
        next[qIdx].selectedLabels = cur.includes(label) ? [] : [label];
      }
      return next;
    });
  }

  function setFreeText(qIdx: number, text: string) {
    userEdited.current[qIdx] = true;
    setAnswers((prev) => {
      const next = prev.map((a) => ({ ...a, selectedLabels: [...a.selectedLabels] }));
      next[qIdx].freeText = text;
      return next;
    });
  }

  const canSubmit = answers.every((a, i) => a.selectedLabels.length > 0 || a.freeText.trim().length > 0 || !set.questions[i]);

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectIdFromHash())}/agent-questions/${encodeURIComponent(set.toolUseId)}/answer`, {
        method: "POST",
        body: JSON.stringify({
          workspaceId: set.workspaceId,
          questions: set.questions,
          answers,
        }),
      });
      onAnswered();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to submit answer");
      setSubmitting(false);
    }
  }

  const staleness = set.staleness ?? null;

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-900/10 shadow-sm" data-testid={`agent-question-${set.toolUseId}`}>
      {/* Collapsed header — click anywhere on the row (except the X) to expand. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
          aria-expanded={expanded}
          data-testid={`agent-question-toggle-${set.toolUseId}`}
        >
          <svg
            className={`w-3.5 h-3.5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs text-gray-700 dark:text-gray-300 truncate">{collapsedSummary(set)}</span>
          {staleness && <StalenessBadge staleness={staleness} />}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={submitting}
          className="shrink-0 p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/60 dark:hover:bg-gray-700 transition-colors disabled:opacity-40"
          title="Dismiss this question (the agent is not notified)"
          aria-label="Dismiss question"
          data-testid={`agent-question-dismiss-${set.toolUseId}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {!expanded ? null : (
      <div className="px-4 pb-4">
        <div className="space-y-4">
        {set.questions.map((q, qIdx) => {
          const multi = !!q.multiSelect;
          const rec = q.recommendation;
          const recPending = rec === undefined;
          const recommendedIdxs = new Set(rec?.recommendedOptionIndexes ?? []);
          return (
            <div key={qIdx} className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-3">
              {q.header && (
                <div className="text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-semibold mb-1">{q.header}</div>
              )}
              <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 whitespace-pre-wrap">{q.question}</div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {multi ? "Select one or more" : "Select one"}
                </div>
                {recPending && (
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="butler-reviewing">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    <span>Butler is reviewing…</span>
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                {q.options.map((opt, optIdx) => {
                  const selected = answers[qIdx].selectedLabels.includes(opt.label);
                  const recommended = recommendedIdxs.has(optIdx);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => toggleOption(qIdx, opt.label, multi)}
                      disabled={submitting}
                      className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors ${
                        selected
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-gray-900 dark:text-gray-100"
                          : recommended
                            ? "border-amber-400 dark:border-amber-500/70 ring-1 ring-amber-300 dark:ring-amber-600/50 bg-amber-50/50 dark:bg-amber-900/10 text-gray-800 dark:text-gray-200 hover:border-amber-500"
                            : "border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 text-gray-700 dark:text-gray-300"
                      } disabled:opacity-50`}
                      data-recommended={recommended ? "1" : undefined}
                    >
                      <div className="flex items-start gap-2">
                        <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-4 h-4 ${multi ? "rounded" : "rounded-full"} border ${selected ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 dark:border-gray-600"}`}>
                          {selected && (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-medium">{opt.label}</div>
                            {recommended && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-800/40 text-amber-700 dark:text-amber-300 text-[10px] font-semibold px-1.5 py-0.5 uppercase tracking-wide">
                                Butler recommends
                              </span>
                            )}
                          </div>
                          {opt.description && (
                            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {rec && rec.rationale && (
                <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300/90 italic" data-testid="butler-rationale">
                  Butler: {rec.rationale}
                </div>
              )}
              <textarea
                value={answers[qIdx].freeText}
                onChange={(e) => setFreeText(qIdx, e.target.value)}
                disabled={submitting}
                rows={2}
                placeholder="Optional: add a free-text note or use this instead of an option"
                className="mt-2 w-full resize-y rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
          );
        })}
        </div>

        <div className="flex items-center justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Sending..." : "Send answers to agent"}
          </button>
        </div>
      </div>
      )}
    </div>
  );
}

// Helper because the QuestionCard is closure-captured; we read the projectId
// from a module-level ref set by the panel below to keep the card props minimal.
let _projectIdRef = "";
function projectIdFromHash(): string {
  return _projectIdRef;
}

export function AgentQuestionsPanel({ projectId, onCountChange }: Props) {
  _projectIdRef = projectId;
  const [sets, setSets] = useState<PendingQuestionSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Cards are collapsed by default; this set tracks the ones the user has expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmDismissAll, setConfirmDismissAll] = useState(false);
  const [dismissingAll, setDismissingAll] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<{ questions: PendingQuestionSet[] }>(
        `/api/projects/${projectId}/agent-questions`,
      );
      setSets(data.questions);
      onCountChange?.(data.questions.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load questions");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    setExpanded(new Set());
    setConfirmDismissAll(false);
    void load();
    // Poll every 15s — questions only arrive when sessions complete.
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function removeSet(toolUseId: string) {
    setSets((prev) => {
      const next = prev.filter((s) => s.toolUseId !== toolUseId);
      onCountChange?.(next.length);
      return next;
    });
    setExpanded((prev) => {
      if (!prev.has(toolUseId)) return prev;
      const next = new Set(prev);
      next.delete(toolUseId);
      return next;
    });
  }

  function toggle(toolUseId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(toolUseId)) next.delete(toolUseId);
      else next.add(toolUseId);
      return next;
    });
  }

  // DELETE the question server-side, then drop it from the list. The agent is not notified.
  async function dismissOne(toolUseId: string) {
    removeSet(toolUseId);
    try {
      await apiFetch(`/api/projects/${projectId}/agent-questions/${encodeURIComponent(toolUseId)}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss question");
      void load(); // reconcile — the card may still be pending server-side.
    }
  }

  async function dismissAll() {
    setDismissingAll(true);
    const ids = sets.map((s) => s.toolUseId);
    try {
      await Promise.all(
        ids.map((id) => apiFetch(`/api/projects/${projectId}/agent-questions/${encodeURIComponent(id)}`, { method: "DELETE" })),
      );
      setSets([]);
      setExpanded(new Set());
      onCountChange?.(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss questions");
      void load();
    } finally {
      setDismissingAll(false);
      setConfirmDismissAll(false);
    }
  }

  if (loading && sets.length === 0) return null;
  if (sets.length === 0 && !error) return null;

  return (
    <div className="shrink-0 border-t border-amber-200 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-900/10" data-testid="agent-questions-panel">
      <div className="max-w-3xl mx-auto px-4 py-2">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-amber-800 dark:text-amber-300">
            {sets.length} pending agent question{sets.length === 1 ? "" : "s"}
          </h3>
          {sets.length >= 2 && (
            <button
              type="button"
              onClick={() => setConfirmDismissAll(true)}
              disabled={dismissingAll}
              className="text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 underline-offset-2 hover:underline disabled:opacity-40"
              data-testid="dismiss-all-questions"
            >
              Dismiss all
            </button>
          )}
        </div>
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</div>
        )}
        {/* Hard max-height keeps the chat above this panel anchored visible. */}
        <div className="space-y-2 overflow-y-auto pr-1" style={{ maxHeight: "min(30vh, 400px)" }}>
          {sets.map((set) => (
            <QuestionCard
              key={set.toolUseId}
              set={set}
              expanded={expanded.has(set.toolUseId)}
              onToggle={() => toggle(set.toolUseId)}
              onAnswered={() => removeSet(set.toolUseId)}
              onDismiss={() => void dismissOne(set.toolUseId)}
              onError={(msg) => setError(msg)}
            />
          ))}
        </div>
      </div>

      {confirmDismissAll && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="dismiss-all-modal">
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl p-5">
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1">Dismiss all pending questions?</h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              This clears all {sets.length} questions from your inbox. The agents are <strong>not</strong> notified and their workspaces are left untouched.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDismissAll(false)}
                disabled={dismissingAll}
                className="px-3 py-1.5 text-xs rounded-lg text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void dismissAll()}
                disabled={dismissingAll}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                data-testid="confirm-dismiss-all"
              >
                {dismissingAll ? "Dismissing…" : "Dismiss all"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Hook for the badge — separate from the panel so the toolbar can show a count
 *  without depending on the butler view being mounted. */
export function useAgentQuestionsCount(projectId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!projectId) {
      setCount(0);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const data = await apiFetch<{ questions: PendingQuestionSet[] }>(
          `/api/projects/${projectId}/agent-questions`,
        );
        if (!cancelled) setCount(data.questions.length);
      } catch {
        if (!cancelled) setCount(0);
      }
    }
    void load();
    const interval = setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId]);
  return count;
}
