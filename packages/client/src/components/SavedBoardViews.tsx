import { useEffect, useMemo, useState } from "react";
import {
  boardSavedViewsKey,
  deleteSavedBoardView,
  renameSavedBoardView,
  resolveBoardViewState,
  sanitizeSavedBoardViews,
  upsertSavedBoardView,
  type BoardViewState,
  type SavedBoardView,
  type SavedViewReference,
} from "../lib/boardSavedViews.js";
import { apiFetch } from "../lib/api.js";
import { showToast } from "./Toast.js";

interface SavedBoardViewsProps {
  projectId: string;
  currentState: BoardViewState;
  statuses: SavedViewReference[];
  tags: SavedViewReference[];
  onApply: (state: BoardViewState) => void;
  onLoadTags: () => Promise<SavedViewReference[]>;
}

export function SavedBoardViews({
  projectId,
  currentState,
  statuses,
  tags,
  onApply,
  onLoadTags,
}: SavedBoardViewsProps) {
  const [views, setViews] = useState<SavedBoardView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [viewName, setViewName] = useState("");
  const [saving, setSaving] = useState(false);
  const settingsKey = useMemo(() => boardSavedViewsKey(projectId), [projectId]);
  const selectedView = views.find((view) => view.id === selectedViewId);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Record<string, string>>("/api/preferences/settings")
      .then((settings) => {
        if (cancelled) return;
        const loaded = sanitizeSavedBoardViews(settings[settingsKey]);
        setViews(loaded);
        setSelectedViewId((current) => loaded.some((view) => view.id === current) ? current : "");
      })
      .catch(() => {
        if (!cancelled) setViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsKey]);

  async function persist(nextViews: SavedBoardView[], message: string) {
    setSaving(true);
    try {
      await apiFetch("/api/preferences/settings", {
        method: "PUT",
        body: JSON.stringify({ [settingsKey]: JSON.stringify(nextViews) }),
      });
      setViews(nextViews);
      showToast(message, "success");
      return true;
    } catch {
      showToast("Failed to save board views", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveCurrentView() {
    const name = viewName.trim();
    if (!name) return;
    const next = upsertSavedBoardView(views, name, currentState);
    const saved = await persist(next, `Saved view "${name}"`);
    if (!saved) return;
    setViewName("");
    const savedView = next.find((view) => view.name.toLowerCase() === name.toLowerCase());
    setSelectedViewId(savedView?.id ?? "");
  }

  async function applyView(viewId: string) {
    setSelectedViewId(viewId);
    const view = views.find((candidate) => candidate.id === viewId);
    if (!view) return;
    const availableTags = view.state.tagId || view.state.tagName ? await onLoadTags() : tags;
    const resolved = resolveBoardViewState(view.state, statuses, availableTags);
    onApply(resolved.state);
    if (resolved.dropped.length > 0) {
      showToast(`Applied "${view.name}" without missing ${resolved.dropped.join(" and ")} filter`, "error");
    }
  }

  async function renameSelectedView() {
    if (!selectedView) return;
    const nextName = window.prompt("Rename saved view", selectedView.name)?.trim();
    if (!nextName || nextName === selectedView.name) return;
    const next = renameSavedBoardView(views, selectedView.id, nextName);
    await persist(next, `Renamed view "${nextName}"`);
  }

  async function deleteSelectedView() {
    if (!selectedView) return;
    if (!window.confirm(`Delete saved view "${selectedView.name}"?`)) return;
    const next = deleteSavedBoardView(views, selectedView.id);
    const deleted = await persist(next, `Deleted view "${selectedView.name}"`);
    if (deleted) setSelectedViewId("");
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-md border border-black/[0.07] bg-surface-raised px-2 py-1.5 text-xs dark:border-white/10 dark:bg-surface-raised-dark">
      <select
        value={currentState.statusId ?? ""}
        onChange={(event) => {
          const status = statuses.find((candidate) => candidate.id === event.target.value);
          onApply({ ...currentState, statusId: status?.id ?? null, statusName: status?.name ?? null });
          setSelectedViewId("");
        }}
        className="max-w-[150px] rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Filter by status"
        title="Filter by status"
      >
        <option value="">All statuses</option>
        {statuses.map((status) => (
          <option key={status.id} value={status.id}>{status.name}</option>
        ))}
      </select>
      <select
        value={currentState.tagId ?? ""}
        onFocus={() => void onLoadTags()}
        onChange={(event) => {
          const tag = tags.find((candidate) => candidate.id === event.target.value);
          onApply({ ...currentState, tagId: tag?.id ?? null, tagName: tag?.name ?? null });
          setSelectedViewId("");
        }}
        className="max-w-[150px] rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Filter by tag"
        title="Filter by tag"
      >
        <option value="">All tags</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>{tag.name}</option>
        ))}
      </select>
      <select
        value={selectedViewId}
        onChange={(event) => void applyView(event.target.value)}
        className="max-w-[170px] rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Saved board view"
        title="Apply saved board view"
      >
        <option value="">Saved views...</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>{view.name}</option>
        ))}
      </select>
      <input
        value={viewName}
        onChange={(event) => setViewName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void saveCurrentView();
        }}
        placeholder="View name"
        className="w-28 rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 placeholder:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        aria-label="Saved view name"
      />
      <button
        type="button"
        onClick={() => void saveCurrentView()}
        disabled={saving || !viewName.trim()}
        className="rounded border border-black/[0.07] px-2 py-1 font-medium text-ink-soft hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-gray-800"
        title="Save current board filters as a named view"
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => void renameSelectedView()}
        disabled={saving || !selectedView}
        className="rounded p-1 text-ink-soft hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        aria-label="Rename saved view"
        title="Rename saved view"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 7.125 16.875 4.5" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => void deleteSelectedView()}
        disabled={saving || !selectedView}
        className="rounded p-1 text-ink-soft hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
        aria-label="Delete saved view"
        title="Delete saved view"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7 18.133 19.142A2 2 0 0 1 16.138 21H7.862A2 2 0 0 1 5.867 19.142L5 7m5 4v6m4-6v6M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M4 7h16" />
        </svg>
      </button>
    </div>
  );
}
