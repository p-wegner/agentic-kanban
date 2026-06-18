import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import { apiFetch } from "../lib/api.js";
import { getSettings } from "../lib/settingsStore.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { showToast } from "./Toast.js";

interface StartWorkspacePickerProps {
  issues: IssueWithStatus[];
  onClose: () => void;
  onStarted: (workspaceId: string, issue: IssueWithStatus) => void;
}

export function StartWorkspacePicker({ issues, onClose, onStarted }: StartWorkspacePickerProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [starting, setStarting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Only show issues that don't already have an active workspace
  const candidates = useMemo(
    () =>
      issues.filter((iss) => {
        const ws = iss.workspaceSummary?.main;
        return !ws || ws.status === "closed";
      }),
    [issues],
  );

  const filtered = useMemo(() => {
    if (!query) return candidates;
    const q = query.toLowerCase();
    return candidates.filter(
      (iss) =>
        iss.title.toLowerCase().includes(q) ||
        String(iss.issueNumber).includes(q) ||
        iss.statusName?.toLowerCase().includes(q),
    );
  }, [query, candidates]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.querySelector("[data-selected='true']") as HTMLElement;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  async function startWorkspace(issue: IssueWithStatus) {
    if (starting) return;
    setStarting(true);
    try {
      const [settings] = await Promise.all([
        getSettings().catch(() => ({} as Record<string, string>)),
      ]);
      const provider = (settings.provider as "claude" | "codex" | "copilot") || "claude";
      const profileName =
        provider === "codex"
          ? settings.codex_profile || "default"
          : provider === "copilot"
          ? settings.copilot_profile || "default"
          : settings.claude_profile || "default";

      const branch = suggestBranchName(issue);
      const body: Record<string, unknown> = {
        issueId: issue.id,
        branch,
        profile: { provider, name: profileName },
      };
      if (settings.default_model) body.model = settings.default_model;

      const result = await apiFetch<{ id: string; sessionId?: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(body),
      });
      showToast(`Workspace started for #${issue.issueNumber} ${issue.title}`, "success");
      onStarted(result.id, issue);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to start workspace", "error");
      setStarting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const issue = filtered[selectedIndex];
      if (issue) startWorkspace(issue);
      return;
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl z-50 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Pick an issue to start a workspace…"
            className="flex-1 text-sm outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500 text-gray-900 dark:text-gray-100 bg-transparent"
            disabled={starting}
          />
          {query && !starting && (
            <button
              onClick={() => setQuery("")}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1"
            >
              ✕
            </button>
          )}
          <kbd className="hidden sm:inline-flex text-[10px] text-gray-400 dark:text-gray-500 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 shrink-0">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
          {starting && (
            <div className="px-4 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
              Starting workspace…
            </div>
          )}
          {!starting && filtered.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
              {candidates.length === 0
                ? "No issues without an active workspace"
                : `No issues matching "${query}"`}
            </div>
          )}
          {!starting && filtered.map((issue, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <div
                key={issue.id}
                data-selected={isSelected}
                className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-brand-50 dark:bg-brand-900/30 border-l-2 border-brand-500"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800 border-l-2 border-transparent"
                }`}
                onClick={() => startWorkspace(issue)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <span className={`w-6 h-6 rounded flex items-center justify-center text-xs shrink-0 font-mono ${
                  isSelected ? "bg-brand-100 text-brand-600" : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                }`}>
                  {issue.issueNumber ?? "?"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {issue.title}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {issue.statusName}
                  </div>
                </div>
                {isSelected && (
                  <span className="text-xs text-brand-500 shrink-0">↵ start</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex items-center gap-3 text-[10px] text-gray-400 dark:text-gray-500">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> start workspace</span>
            <span><kbd className="font-mono">Esc</kbd> close</span>
          </div>
          <span className="text-[10px] text-gray-300 dark:text-gray-600">
            {filtered.length} issue{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </>
  );
}
