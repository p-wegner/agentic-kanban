import { useEffect, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { LaunchPreviewPanel } from "./LaunchPreviewPanel.js";
import { Button } from "./Button.js";

interface AgentStartDryRunModalProps {
  issue: IssueWithStatus;
  onClose: () => void;
  onStartWorkspace: (issue: IssueWithStatus) => void;
}

export function AgentStartDryRunModal({ issue, onClose, onStartWorkspace }: AgentStartDryRunModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [branch] = useState(() => suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title }));

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={handleOverlayClick}
      aria-modal="true"
      role="dialog"
      aria-label={`Dry run preview for issue ${issue.issueNumber ? `#${issue.issueNumber}` : issue.title}`}
    >
      <div className="relative w-[min(480px,95vw)] bg-surface-raised dark:bg-surface-raised-dark rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="h-4 w-4 text-gray-500 dark:text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7Z" />
            </svg>
            <h2 className="text-sm font-semibold text-ink dark:text-stone-100 truncate">
              Dry Run Preview
            </h2>
          </div>
          <Button
            variant="ghost"
            iconOnly
            onClick={onClose}
            className="shrink-0 text-lg leading-none"
            aria-label="Close dry run preview"
          >
            &times;
          </Button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3 flex-1">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {issue.issueNumber != null && (
                <span className="mr-1">#{issue.issueNumber}</span>
              )}
            </p>
            <p className="text-sm font-medium text-ink dark:text-stone-100 leading-snug">
              {issue.title}
            </p>
          </div>

          <LaunchPreviewPanel
            issueId={issue.id}
            branch={branch}
            baseBranch=""
            isDirect={false}
            requiresReview={false}
            planMode={undefined}
            tddMode={false}
            skipSetup={false}
            skillId=""
            selectedProfile=""
            selectedModel=""
            disabled={false}
          />
        </div>

        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => { onStartWorkspace(issue); onClose(); }}
          >
            Start Workspace
          </Button>
        </div>
      </div>
    </div>
  );
}
