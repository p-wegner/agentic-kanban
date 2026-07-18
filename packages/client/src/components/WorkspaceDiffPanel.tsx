import { useState } from "react";
import { apiPost, apiPatch, apiDelete } from "../lib/api.js";
import { DiffViewer } from "./DiffViewer.js";
import type { DiffResponse, DiffComment, CreateDiffCommentRequest } from "@agentic-kanban/shared";

interface WorkspaceDiffPanelProps {
  diff: DiffResponse;
  diffComments: DiffComment[];
  workspaceId: string;
  onClose: () => void;
  onCommentsChange: (comments: DiffComment[]) => void;
  onError: (msg: string) => void;
}

type RepoSection = NonNullable<DiffResponse["repos"]>[number];

function repoDisplayName(repo: RepoSection): string {
  if (repo.name) return repo.name;
  const base = repo.path.split(/[\\/]/).filter(Boolean).pop();
  return base ?? repo.path;
}

interface DiffHandlers {
  onCreateComment: (data: CreateDiffCommentRequest) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onResolveComment: (commentId: string, resolved: boolean) => void;
}

function RepoDiffSection({
  repo,
  idx,
  isLeading,
  expanded,
  onToggle,
  comments,
  handlers,
}: {
  repo: RepoSection;
  idx: number;
  isLeading: boolean;
  expanded: boolean;
  onToggle: () => void;
  comments: DiffComment[];
  handlers: DiffHandlers;
}) {
  return (
    <div id={`repo-diff-section-${idx}`} data-testid={`repo-diff-section-${idx}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer select-none transition-colors text-left border-b border-gray-200 dark:border-gray-700"
      >
        <svg
          className={`w-3.5 h-3.5 text-gray-500 dark:text-gray-400 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate" title={repo.path}>
          {repoDisplayName(repo)}
        </span>
        {isLeading && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 shrink-0">
            leading
          </span>
        )}
        {repo.conflicts?.hasConflicts && (
          <span
            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 shrink-0"
            title={repo.conflicts.conflictingFiles.join(", ")}
          >
            conflicts
          </span>
        )}
        <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0 ml-auto">
          {repo.stats.filesChanged} file{repo.stats.filesChanged !== 1 ? "s" : ""}
        </span>
        <span className="text-xs text-green-600 font-medium shrink-0">+{repo.stats.insertions}</span>
        <span className="text-xs text-red-600 font-medium shrink-0">-{repo.stats.deletions}</span>
      </button>
      {expanded && (
        repo.diff ? (
          <div className="p-2">
            <DiffViewer
              diff={repo.diff}
              stats={repo.stats}
              comments={comments}
              onCreateComment={handlers.onCreateComment}
              onEditComment={handlers.onEditComment}
              onDeleteComment={handlers.onDeleteComment}
              onResolveComment={handlers.onResolveComment}
            />
          </div>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400 italic px-3 py-2">
            No changes in this repo.
          </div>
        )
      )}
    </div>
  );
}

function MultiRepoDiff({
  repos,
  comments,
  handlers,
}: {
  repos: RepoSection[];
  comments: DiffComment[];
  handlers: DiffHandlers;
}) {
  const [expandedRepos, setExpandedRepos] = useState<Set<number>>(() => new Set(repos.map((_, i) => i)));

  function jumpToRepo(idx: number) {
    setExpandedRepos(prev => { const n = new Set(prev); n.add(idx); return n; });
    setTimeout(() => {
      document.getElementById(`repo-diff-section-${idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  return (
    <div>
      <div className="flex items-center gap-1 px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex-wrap" data-testid="repo-jump-nav">
        <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500 mr-1">Repos:</span>
        {repos.map((repo, i) => (
          <button
            key={i}
            onClick={() => jumpToRepo(i)}
            className="text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-brand-100 dark:hover:bg-brand-900/40 hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
            title={repo.path}
          >
            {repoDisplayName(repo)}
            <span className="text-gray-400 dark:text-gray-500 ml-1">{repo.stats.filesChanged}</span>
          </button>
        ))}
      </div>
      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {repos.map((repo, i) => (
          <RepoDiffSection
            key={i}
            repo={repo}
            idx={i}
            isLeading={i === 0}
            expanded={expandedRepos.has(i)}
            onToggle={() => {
              setExpandedRepos(prev => {
                const next = new Set(prev);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              });
            }}
            comments={comments}
            handlers={handlers}
          />
        ))}
      </div>
    </div>
  );
}

export function WorkspaceDiffPanel({ diff, diffComments, workspaceId, onClose, onCommentsChange, onError }: WorkspaceDiffPanelProps) {
  async function handleCreateComment(data: CreateDiffCommentRequest) {
    try {
      const result = await apiPost<DiffComment>(`/api/workspaces/${workspaceId}/comments`, data);
      onCommentsChange([...diffComments, result]);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create comment");
    }
  }

  async function handleEditComment(commentId: string, body: string) {
    try {
      await apiPatch(`/api/workspaces/${workspaceId}/comments/${commentId}`, { body });
      onCommentsChange(diffComments.map(c => c.id === commentId ? { ...c, body, updatedAt: new Date().toISOString() } : c));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update comment");
    }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      await apiDelete(`/api/workspaces/${workspaceId}/comments/${commentId}`);
      onCommentsChange(diffComments.filter(c => c.id !== commentId));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete comment");
    }
  }

  async function handleResolveComment(commentId: string, resolved: boolean) {
    try {
      const result = await apiPatch<DiffComment>(`/api/workspaces/${workspaceId}/comments/${commentId}/resolve`, { resolved });
      onCommentsChange(diffComments.map(c => c.id === commentId ? { ...c, resolvedAt: result.resolvedAt } : c));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update comment");
    }
  }

  const handlers: DiffHandlers = {
    onCreateComment: handleCreateComment,
    onEditComment: handleEditComment,
    onDeleteComment: handleDeleteComment,
    onResolveComment: handleResolveComment,
  };

  const multiRepo = diff.repos != null && diff.repos.length > 0;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          Diff
          {multiRepo && (
            <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
              {diff.repos!.length} repos
            </span>
          )}
        </h3>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
        >
          Close
        </button>
      </div>
      <div className="max-h-[500px] overflow-y-auto">
        {multiRepo ? (
          <MultiRepoDiff repos={diff.repos!} comments={diffComments} handlers={handlers} />
        ) : (
          <DiffViewer
            diff={diff.diff}
            stats={diff.stats}
            comments={diffComments}
            onCreateComment={handlers.onCreateComment}
            onEditComment={handlers.onEditComment}
            onDeleteComment={handlers.onDeleteComment}
            onResolveComment={handlers.onResolveComment}
          />
        )}
      </div>
    </div>
  );
}
