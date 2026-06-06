import React from "react";
import ReactMarkdown from "react-markdown";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";

// Some issues were created via MCP/CLI calls whose JSON descriptions ended up
// with literal `\n` / `\t` sequences rather than real newlines. Unescape when
// the string has no real newlines so ReactMarkdown can render headings/lists.
function normalizeMarkdown(s: string): string {
  if (s.includes("\n")) return s;
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export interface IssueComment {
  id: string;
  issueId: string;
  workspaceId: string | null;
  kind: string;
  author: string;
  body: string;
  payload: unknown;
  createdAt: string;
}

const COMMENT_KIND_LABELS: Record<string, string> = {
  "preflight-clarification": "Preflight clarification",
  "agent-question": "Agent question",
  "merge-attempt": "Merge attempt",
  note: "Note",
};

function mergeAttemptPayload(payload: unknown): { eventType?: string; sessionId?: string; commitSha?: string } {
  if (!payload || typeof payload !== "object") return {};
  const data = payload as Record<string, unknown>;
  return {
    eventType: typeof data.eventType === "string" ? data.eventType : undefined,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    commitSha: typeof data.commitSha === "string" ? data.commitSha : undefined,
  };
}

export interface IssueDetailCommentsProps {
  issue: IssueWithStatus;
  comments: IssueComment[];
  newNoteBody: string;
  submittingNote: boolean;
  deletingCommentId: string | null;
  onNewNoteBodyChange: (value: string) => void;
  onAddNote: () => void;
  onDeleteComment: (commentId: string) => void;
  onManageWorkspaces: (issue: IssueWithStatus, workspaceId?: string, sessionId?: string) => void;
}

export function IssueDetailComments({
  issue,
  comments,
  newNoteBody,
  submittingNote,
  deletingCommentId,
  onNewNoteBodyChange,
  onAddNote,
  onDeleteComment,
  onManageWorkspaces,
}: IssueDetailCommentsProps) {
  const systemComments = comments.filter((c) => c.kind !== "note");
  const noteComments = comments.filter((c) => c.kind === "note");

  return (
    <>
      {/* System comments: preflight clarifications, agent questions, merge attempts */}
      {systemComments.length > 0 && (
        <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-2">
            Clarifications &amp; activity
          </label>
          <ul className="space-y-2">
            {systemComments.map((cmt) => (
              <li
                key={cmt.id}
                className="border border-gray-200 dark:border-gray-700 rounded px-2.5 py-2 bg-gray-50 dark:bg-gray-800/50"
              >
                <div className="flex items-center gap-2 mb-1 text-[11px]">
                  <span className={`font-medium px-1.5 py-0.5 rounded ${
                    cmt.kind === "preflight-clarification"
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                      : cmt.kind === "agent-question"
                      ? "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300"
                      : cmt.kind === "merge-attempt"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                  }`}>
                    {COMMENT_KIND_LABELS[cmt.kind] ?? cmt.kind}
                  </span>
                  <span className="text-gray-400 dark:text-gray-500 capitalize">{cmt.author}</span>
                  <span className="text-gray-400 dark:text-gray-500 ml-auto">{formatRelativeTime(cmt.createdAt)}</span>
                </div>
                <div className="markdown-body text-sm">
                  <ReactMarkdown>{normalizeMarkdown(cmt.body)}</ReactMarkdown>
                </div>
                {cmt.kind === "merge-attempt" && (() => {
                  const payload = mergeAttemptPayload(cmt.payload);
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                      {cmt.workspaceId && (
                        <button
                          type="button"
                          onClick={() => onManageWorkspaces(issue, cmt.workspaceId!, payload.sessionId ?? "")}
                          className="text-emerald-700 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200 font-medium"
                        >
                          {payload.sessionId ? "Open session" : "Open workspace"}
                        </button>
                      )}
                      {payload.commitSha && (
                        <span className="font-mono text-gray-400 dark:text-gray-500">
                          {payload.commitSha.slice(0, 12)}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Discussion: user-authored notes with markdown rendering and input */}
      <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400 block mb-2">
          Discussion
        </label>
        {noteComments.length > 0 && (
          <ul className="space-y-2 mb-3">
            {noteComments.map((cmt) => (
              <li
                key={cmt.id}
                className="border border-gray-200 dark:border-gray-700 rounded px-2.5 py-2 bg-gray-50 dark:bg-gray-800/50 group"
              >
                <div className="flex items-center gap-2 mb-1 text-[11px]">
                  <span className="text-gray-500 dark:text-gray-400 capitalize font-medium">{cmt.author}</span>
                  <span className="text-gray-400 dark:text-gray-500 ml-auto">{formatRelativeTime(cmt.createdAt)}</span>
                  <button
                    type="button"
                    disabled={deletingCommentId === cmt.id}
                    onClick={() => onDeleteComment(cmt.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-opacity disabled:opacity-30"
                    aria-label="Delete comment"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
                <div className="markdown-body text-sm">
                  <ReactMarkdown>{normalizeMarkdown(cmt.body)}</ReactMarkdown>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-1.5">
          <textarea
            value={newNoteBody}
            onChange={(e) => onNewNoteBodyChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onAddNote();
              }
            }}
            placeholder="Add a note… (Markdown supported, Ctrl+Enter to submit)"
            rows={3}
            className="w-full text-sm px-2.5 py-2 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            type="button"
            disabled={!newNoteBody.trim() || submittingNote}
            onClick={onAddNote}
            className="self-end text-xs px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {submittingNote ? "Adding…" : "Add note"}
          </button>
        </div>
      </div>
    </>
  );
}
