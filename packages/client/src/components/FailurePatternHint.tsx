import React, { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";

interface FailurePattern {
  id: string;
  title: string;
  errorClass: string | null;
  rootCause: string | null;
  fix: string | null;
  sourceRef: string | null;
}

interface PatternMatch {
  pattern: FailurePattern;
  score: number;
  matchedKeywords: string[];
}

interface FailurePatternHintProps {
  workspaceId: string;
  /** Last session's stderr text (first 500 chars is enough for matching). */
  sessionId: string | null;
}

/**
 * Shows top-3 similar past failures when the most recent session ended non-zero.
 * Fetches stderr from the session output and queries /api/failure-patterns/search.
 */
export function FailurePatternHint({ workspaceId, sessionId }: FailurePatternHintProps) {
  const [matches, setMatches] = useState<PatternMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setMatches([]);
      return;
    }

    setLoading(true);
    apiFetch<{ type: string; data: string | null }[]>(`/api/sessions/${sessionId}/output`)
      .then((msgs) => {
        const stderrText = msgs
          .filter(m => m.type === "stderr" && m.data)
          .map(m => m.data ?? "")
          .slice(-50)
          .join("\n");

        if (!stderrText.trim()) {
          setMatches([]);
          setLoading(false);
          return;
        }

        const params = new URLSearchParams({ q: stderrText.slice(0, 1000), limit: "3" });
        return apiFetch<PatternMatch[]>(`/api/failure-patterns/search?${params}`).then((m) => {
          setMatches(m ?? []);
          setLoading(false);
        });
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  if (loading || matches.length === 0) return null;

  return (
    <div className="mt-2 border border-amber-200 dark:border-amber-700 rounded bg-amber-50 dark:bg-amber-950 text-xs">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900 rounded"
      >
        <svg className={`w-3 h-3 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span>🔍 Failure pattern memory: {matches.length} similar past incident{matches.length > 1 ? "s" : ""} found</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2 space-y-2">
          {matches.map((m, i) => (
            <div key={m.pattern.id} className="border border-amber-200 dark:border-amber-700 rounded p-2 bg-white dark:bg-gray-900">
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold text-amber-900 dark:text-amber-100">
                  {i + 1}. {m.pattern.title}
                </span>
                <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-800 text-amber-700 dark:text-amber-200">
                  {Math.round(m.score * 100)}% match
                </span>
              </div>
              {m.pattern.errorClass && (
                <div className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                  Error class: <code className="font-mono">{m.pattern.errorClass}</code>
                </div>
              )}
              {m.pattern.rootCause && (
                <div className="mt-1 text-gray-700 dark:text-gray-300">
                  <span className="font-medium">Root cause: </span>
                  {m.pattern.rootCause.slice(0, 200)}{m.pattern.rootCause.length > 200 ? "…" : ""}
                </div>
              )}
              {m.pattern.fix && (
                <div className="mt-1 text-gray-700 dark:text-gray-300">
                  <span className="font-medium text-green-700 dark:text-green-400">Fix: </span>
                  {m.pattern.fix.slice(0, 200)}{m.pattern.fix.length > 200 ? "…" : ""}
                </div>
              )}
              {m.pattern.sourceRef && (
                <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500 font-mono truncate">
                  📄 {m.pattern.sourceRef.split(/[\\/]/).slice(-2).join("/")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
