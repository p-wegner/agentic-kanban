import { useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import type { TodoItem } from "../lib/useBoardEvents.js";
import {
  commitCountClass,
  coverageClass,
  workflowDotClasses,
  workflowStateClasses,
  type WorkflowSnapshot,
} from "../lib/issueCardColorMap.js";

export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return <>{text}</>;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);

  return (
    <>
      {before}
      <mark className="bg-yellow-200 rounded px-0.5">{match}</mark>
      {after}
    </>
  );
}

export function WorkflowMiniIndicator({ workflow }: { workflow: WorkflowSnapshot }) {
  const [open, setOpen] = useState(false);
  const nextLabel = workflow.nextStages.length > 0 ? workflow.nextStages.join(", ") : "None";
  const title = `Workflow: ${workflow.currentNodeName}. Next: ${nextLabel}`;

  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        title={title}
        aria-label={title}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex max-w-[8.5rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${workflowStateClasses[workflow.state]}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${workflowDotClasses[workflow.state]} ${workflow.state === "active" ? "animate-pulse" : ""}`} />
        <span className="truncate">{workflow.currentNodeName}</span>
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white p-2 text-left shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          <span className="block text-[11px] font-semibold text-gray-800 dark:text-gray-100">
            {workflow.currentNodeName}
          </span>
          <span className="mt-1 block text-[10px] text-gray-500 dark:text-gray-400">
            Next: {nextLabel}
          </span>
        </span>
      )}
    </span>
  );
}

export function CodeMetricsBadges({
  commitCount,
  metrics,
}: {
  commitCount?: number | null;
  metrics: NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>["codeMetrics"] | null | undefined;
}) {
  const coverage = metrics?.coverage;
  const lint = metrics?.lint;
  const complexity = metrics?.complexity;

  return (
    <>
      {commitCount !== undefined && commitCount !== null ? (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${commitCountClass(commitCount)}`}
          title="Commits ahead of base branch"
        >
          +{commitCount}
        </span>
      ) : (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
          title="Commit count unavailable"
        >
          commits -
        </span>
      )}
      {coverage ? (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${coverageClass(coverage.linesPct)}`}
          title={`Line coverage: ${coverage.linesPct}% from ${coverage.source}`}
        >
          cov {Math.round(coverage.linesPct)}%
        </span>
      ) : (
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500"
          title={metrics ? "No coverage summary found" : "Code metrics not collected yet"}
        >
          cov -
        </span>
      )}
      {lint && (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
            lint.errors > 0 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" :
            lint.warnings > 0 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
            "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
          }`}
          title={`${lint.errors} lint error(s), ${lint.warnings} warning(s) from ${lint.source}`}
        >
          lint {lint.violations}
        </span>
      )}
      {complexity && (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${
            complexity.average <= 20 ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" :
            complexity.average <= 40 ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" :
            "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
          }`}
          title={`Heuristic complexity: average ${complexity.average}, max ${complexity.max} across ${complexity.files} source file(s)`}
        >
          cx {complexity.average}
        </span>
      )}
    </>
  );
}

export function TodoProgress({ todos }: { todos: TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;

  return (
    <div className="mt-1.5 px-1">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="w-full text-left"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <svg
            className={`w-2.5 h-2.5 text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="currentColor" viewBox="0 0 16 16"
          >
            <path d="M6 12l4-4-4-4v8z" />
          </svg>
          <span className="text-[10px] text-gray-400 dark:text-gray-500">{completed}/{total} tasks</span>
          {inProgress > 0 && (
            <span className="text-[10px] text-blue-500 font-medium">{inProgress} active</span>
          )}
        </div>
      </button>
      <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden flex ml-3">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${(completed / total) * 100}%` }}
        />
        <div
          className="h-full bg-blue-400 transition-all duration-300"
          style={{ width: `${(inProgress / total) * 100}%` }}
        />
      </div>
      {expanded && (
        <div className="mt-1 ml-3 space-y-0.5">
          {todos.map((t, i) => (
            <div key={i} className="flex items-start gap-1 text-[10px]">
              <span className="shrink-0 mt-0.5">
                {t.status === "completed" ? (
                  <svg className="w-2.5 h-2.5 text-green-500" fill="currentColor" viewBox="0 0 16 16"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
                ) : t.status === "in_progress" ? (
                  <svg className="w-2.5 h-2.5 text-blue-500" fill="currentColor" viewBox="0 0 16 16"><path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3 6V3a3 3 0 00-6 0v4a2 2 0 002 2v2.5a.5.5 0 001 0V9a2 2 0 002-2z"/></svg>
                ) : (
                  <svg className="w-2.5 h-2.5 text-gray-300 dark:text-gray-600" fill="currentColor" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>
                )}
              </span>
              <span className={t.status === "completed" ? "text-gray-400 dark:text-gray-500 line-through" : "text-gray-600 dark:text-gray-400"}>
                {t.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
