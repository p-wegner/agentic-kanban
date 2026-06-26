import { computeBlockingDependencies } from "../lib/blockingDependencies.js";
import type { DependencyItem } from "@agentic-kanban/shared";

interface IssueBlockedBannerProps {
  dependencies: DependencyItem[];
  issueId: string;
}

/** Amber banner listing this issue's unresolved blocking dependencies. Renders
 *  nothing when there are none. Extracted verbatim from IssueDetailPanel. */
export function IssueBlockedBanner({ dependencies, issueId }: IssueBlockedBannerProps) {
  const blockingDeps = computeBlockingDependencies(dependencies, issueId);
  if (blockingDeps.length === 0) return null;
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-md px-3 py-2.5 text-sm">
      <div className="flex items-center gap-1.5 font-medium text-amber-800 mb-1.5">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        Blocked by {blockingDeps.length} unresolved {blockingDeps.length === 1 ? "dependency" : "dependencies"}
      </div>
      <ul className="space-y-0.5 pl-5.5">
        {blockingDeps.map((dep) => (
          <li key={dep.id} className="text-amber-700 flex items-center gap-1">
            <span className="text-amber-500 shrink-0">•</span>
            {dep.issueNumber != null && (
              <span className="font-mono text-xs shrink-0">#{dep.issueNumber}</span>
            )}
            <span className="truncate">{dep.issueTitle}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
