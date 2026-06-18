import { useEffect, useMemo, useRef, useState } from "react";
import {
  boardSavedViewsKey,
  boardViewStatesEqual,
  deleteSavedBoardView,
  renameSavedBoardView,
  resolveBoardViewState,
  sanitizeSavedBoardViews,
  upsertSavedBoardView,
  type BoardViewState,
  type SavedBoardView,
  type SavedViewReference,
} from "../lib/boardSavedViews.js";
import { getSettings, setSettings } from "../lib/settingsStore.js";
import { showToast } from "./Toast.js";

interface SavedBoardViewsProps {
  projectId: string;
  currentState: BoardViewState;
  tags: SavedViewReference[];
  onApply: (state: BoardViewState) => void;
  onLoadTags: () => Promise<SavedViewReference[]>;
}

/**
 * A single compact "Views" dropdown for saving / applying named board views
 * (filters + active view, persisted in preferences). Was previously a wider
 * inline row with a separate md/mobile layout and an ambiguous download glyph;
 * collapsed here to match the View / Activity / Filter menu pattern.
 */
export function SavedBoardViews({
  projectId,
  currentState,
  tags,
  onApply,
  onLoadTags,
}: SavedBoardViewsProps) {
  const [views, setViews] = useState<SavedBoardView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [viewName, setViewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsKey = useMemo(() => boardSavedViewsKey(projectId), [projectId]);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (cancelled) return;
        const loaded = sanitizeSavedBoardViews(settings[settingsKey]);
        setViews(loaded);
        setSelectedViewId((current) => {
          if (loaded.some((view) => view.id === current)) return current;
          return loaded.find((view) => boardViewStatesEqual(view.state, currentState))?.id ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) setViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentState, settingsKey]);

  useEffect(() => {
    const active = views.find((view) => boardViewStatesEqual(view.state, currentState));
    setSelectedViewId(active?.id ?? "");
  }, [currentState, views]);

  async function persist(nextViews: SavedBoardView[], message: string) {
    setSaving(true);
    try {
      await setSettings({ [settingsKey]: JSON.stringify(nextViews) });
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
    const availableTags = view.state.tagIds.length > 0 || view.state.tagNames.length > 0 ? await onLoadTags() : tags;
    const resolved = resolveBoardViewState(view.state, availableTags);
    onApply(resolved.state);
    if (resolved.dropped.length > 0) {
      showToast(`Applied "${view.name}" without missing tag filter`, "error");
    }
  }

  async function renameView(view: SavedBoardView) {
    const nextName = window.prompt("Rename saved view", view.name)?.trim();
    if (!nextName || nextName === view.name) return;
    await persist(renameSavedBoardView(views, view.id, nextName), `Renamed view "${nextName}"`);
  }

  async function deleteView(view: SavedBoardView) {
    if (!window.confirm(`Delete saved view "${view.name}"?`)) return;
    const deleted = await persist(deleteSavedBoardView(views, view.id), `Deleted view "${view.name}"`);
    if (deleted && selectedViewId === view.id) setSelectedViewId("");
  }

  const hasViews = views.length > 0;
  const selectedView = views.find((view) => view.id === selectedViewId);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Saved board views"
        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4V5z" />
        </svg>
        <span className="hidden sm:inline max-w-[9rem] truncate">{selectedView?.name ?? "Views"}</span>
        {hasViews && !selectedView && (
          <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-violet-100 px-1 text-[10px] font-semibold leading-none text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
            {views.length}
          </span>
        )}
        <svg className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-900 flex flex-col gap-2">
          {hasViews ? (
            <div className="flex flex-col gap-0.5">
              {views.map((view) => {
                const isSelected = view.id === selectedViewId;
                return (
                  <div
                    key={view.id}
                    className={`group flex items-center gap-1 rounded px-1 ${isSelected ? "bg-surface-sunken dark:bg-gray-800" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => void applyView(view.id)}
                      className="flex-1 truncate rounded px-1 py-1 text-left text-xs text-ink hover:text-brand-700 dark:text-gray-200 dark:hover:text-brand-300"
                      title={`Apply "${view.name}"`}
                    >
                      {view.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => void renameView(view)}
                      disabled={saving}
                      className="rounded p-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-surface-sunken hover:text-ink-soft disabled:cursor-not-allowed dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                      aria-label={`Rename ${view.name}`}
                      title="Rename"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 7.125 16.875 4.5" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteView(view)}
                      disabled={saving}
                      className="rounded p-1 text-ink-faint opacity-0 group-hover:opacity-100 hover:bg-surface-sunken hover:text-red-600 disabled:cursor-not-allowed dark:text-gray-500 dark:hover:bg-gray-700"
                      aria-label={`Delete ${view.name}`}
                      title="Delete"
                    >
                      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7 18.133 19.142A2 2 0 0 1 16.138 21H7.862A2 2 0 0 1 5.867 19.142L5 7m5 4v6m4-6v6M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-1 py-0.5 text-[11px] text-ink-faint dark:text-gray-500">No saved views yet.</p>
          )}
          <div className="flex items-center gap-1 border-t border-gray-100 dark:border-gray-800 pt-2">
            <input
              value={viewName}
              onChange={(event) => setViewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveCurrentView();
              }}
              placeholder="Save current as…"
              className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 placeholder:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              aria-label="Saved view name"
            />
            <button
              type="button"
              onClick={() => void saveCurrentView()}
              disabled={saving || !viewName.trim()}
              className="shrink-0 rounded border border-black/[0.07] px-2 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-gray-800"
              title="Save current filters and view as a named view"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
