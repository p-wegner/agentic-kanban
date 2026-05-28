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
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AgentQuestionOption[];
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

function emptyAnswers(qs: AgentQuestion[]): AnswerState[] {
  return qs.map(() => ({ selectedLabels: [], freeText: "" }));
}

function QuestionCard({
  set,
  onAnswered,
  onError,
}: {
  set: PendingQuestionSet;
  onAnswered: () => void;
  onError: (msg: string) => void;
}) {
  const [answers, setAnswers] = useState<AnswerState[]>(() => emptyAnswers(set.questions));
  const [submitting, setSubmitting] = useState(false);

  function toggleOption(qIdx: number, label: string, multi: boolean) {
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

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-900/10 p-4 shadow-sm" data-testid={`agent-question-${set.toolUseId}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[11px] font-semibold">?</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">Agent waiting on your answers</span>
          <span className="text-gray-500 dark:text-gray-400">·</span>
          <span className="text-gray-600 dark:text-gray-400">
            #{set.issueNumber} {set.issueTitle}
          </span>
        </div>
        {set.askedAt && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            asked {new Date(set.askedAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="space-y-4">
        {set.questions.map((q, qIdx) => {
          const multi = !!q.multiSelect;
          return (
            <div key={qIdx} className="rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-3">
              {q.header && (
                <div className="text-[11px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-semibold mb-1">{q.header}</div>
              )}
              <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 whitespace-pre-wrap">{q.question}</div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500 mb-2">
                {multi ? "Select one or more" : "Select one"}
              </div>
              <div className="space-y-1.5">
                {q.options.map((opt) => {
                  const selected = answers[qIdx].selectedLabels.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => toggleOption(qIdx, opt.label, multi)}
                      disabled={submitting}
                      className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors ${
                        selected
                          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-gray-900 dark:text-gray-100"
                          : "border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 text-gray-700 dark:text-gray-300"
                      } disabled:opacity-50`}
                    >
                      <div className="flex items-start gap-2">
                        <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-4 h-4 ${multi ? "rounded" : "rounded-full"} border ${selected ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300 dark:border-gray-600"}`}>
                          {selected && (
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
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
    void load();
    // Poll every 15s — questions only arrive when sessions complete.
    const interval = setInterval(() => void load(), 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading && sets.length === 0) return null;
  if (sets.length === 0 && !error) return null;

  return (
    <div className="shrink-0 border-b border-amber-200 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-900/10 px-4 py-3 max-h-[60vh] overflow-y-auto" data-testid="agent-questions-panel">
      <div className="max-w-3xl mx-auto space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {sets.length} pending agent question{sets.length === 1 ? "" : "s"}
          </h3>
        </div>
        {error && (
          <div className="text-xs text-red-600 dark:text-red-400">{error}</div>
        )}
        {sets.map((set) => (
          <QuestionCard
            key={set.toolUseId}
            set={set}
            onAnswered={() => {
              setSets((prev) => {
                const next = prev.filter((s) => s.toolUseId !== set.toolUseId);
                onCountChange?.(next.length);
                return next;
              });
            }}
            onError={(msg) => setError(msg)}
          />
        ))}
      </div>
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
