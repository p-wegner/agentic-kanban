import { useState } from "react";
import { apiPost } from "../lib/api.js";
import { showToast } from "../lib/toast.js";

interface UseWorkspaceGithubHandoffDeps {
  setActionLoading: (v: boolean) => void;
  setError: (msg: string | null) => void;
  onWorkspaceChange?: () => void;
}

/**
 * GitHub-handoff actions for a workspace, extracted from WorkspacePanel: generate
 * the handoff draft (PR description), copy it, and export the full handoff bundle
 * as a downloaded Markdown file. Owns the per-workspace draft cache.
 */
export function useWorkspaceGithubHandoff({ setActionLoading, setError, onWorkspaceChange }: UseWorkspaceGithubHandoffDeps) {
  const [githubDrafts, setGithubDrafts] = useState<Record<string, string | null>>({});

  async function handleGenerateGithubDraft(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiPost<{ content: string }>(`/api/workspaces/${wsId}/github-handoff-draft`);
      setGithubDrafts((prev) => ({ ...prev, [wsId]: result.content }));
      try {
        if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(result.content);
        showToast("GitHub draft generated and copied", "success");
      } catch {
        showToast("GitHub draft generated", "success");
      }
      onWorkspaceChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate GitHub draft");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCopyGithubDraft(content: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(content);
      showToast("GitHub draft copied", "success");
    } catch {
      window.prompt("Copy GitHub draft", content);
    }
  }

  async function handleExportHandoffBundle(wsId: string) {
    setActionLoading(true);
    setError(null);
    try {
      const url = `/api/workspaces/${wsId}/handoff-bundle?format=markdown`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const text = await res.text();
      const blob = new Blob([text], { type: "text/markdown" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `handoff-${wsId.slice(0, 8)}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast("Handoff bundle downloaded", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export handoff bundle");
    } finally {
      setActionLoading(false);
    }
  }

  return { githubDrafts, handleGenerateGithubDraft, handleCopyGithubDraft, handleExportHandoffBundle };
}
