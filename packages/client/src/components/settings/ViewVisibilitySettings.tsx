import { useState } from "react";
import {
  PRIMARY_VIEWS,
  SECONDARY_VIEWS,
  UNHIDEABLE_VIEWS,
  type ViewDescriptor,
  type ViewMode,
} from "../../lib/viewRegistry.js";
import { useHiddenViews } from "../../hooks/useHiddenViews.js";

/**
 * Per-project toolbar curation (#233).
 *
 * `VIEW_REGISTRY` holds 41 views — 14 primary tabs plus 27 behind "More" — and until now there
 * was no way to hide any of them: curating the toolbar meant editing the registry and rebuilding.
 * On a board whose whole premise is per-project configuration, that was the gap doing the most
 * damage, and it is strictly cheaper than the extraction/consolidation work it de-risks: with
 * visibility prefs in place, every "is this view clutter?" judgement becomes the user's call per
 * project instead of a code change someone has to be right about.
 *
 * Nothing is deleted or moved here. A hidden view keeps working — its route still resolves, its
 * data still loads — it simply stops occupying toolbar, overflow, palette and shortcut space.
 */
export function ViewVisibilitySettings({ activeProjectId }: { activeProjectId: string | null }) {
  const { hidden, loaded, setHidden, toggle } = useHiddenViews(activeProjectId);
  const [saving, setSaving] = useState(false);

  async function run(action: () => Promise<void>) {
    setSaving(true);
    try { await action(); } finally { setSaving(false); }
  }

  if (!activeProjectId) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Select a project to choose which views its toolbar shows.
      </p>
    );
  }

  function renderGroup(title: string, hint: string, views: ViewDescriptor[]) {
    return (
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">{title}</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{hint}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
          {views.map((view) => {
            const locked = UNHIDEABLE_VIEWS.includes(view.id);
            const shown = !hidden.has(view.id);
            return (
              <label
                key={view.id}
                className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${locked ? "opacity-60" : "hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                title={locked ? "The board view can never be hidden" : view.paletteDescription}
              >
                <input
                  type="checkbox"
                  checked={shown}
                  disabled={locked || saving || !loaded}
                  onChange={(e) => void run(() => toggle(view.id, !e.target.checked))}
                  data-testid={`view-visibility-${view.id}`}
                />
                <span className="text-gray-800 dark:text-gray-200">{view.label}</span>
                {view.shortcut && (
                  <kbd className="ml-auto rounded border border-gray-300 px-1 text-[10px] text-gray-500 dark:border-gray-600 dark:text-gray-400">
                    {view.chord ? `g ${view.shortcut}` : view.shortcut}
                  </kbd>
                )}
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="view-visibility-settings">
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
        Choose which views this project offers. Unchecking one removes it from the toolbar, the
        “More” menu, the command palette and the keyboard shortcuts — it is not deleted, and
        re-checking brings it straight back. {hidden.size > 0 && <strong>{hidden.size} hidden.</strong>}
      </p>
      {renderGroup("Toolbar tabs", "Rendered directly on the board toolbar (overflowing into “More” when the bar is narrow).", PRIMARY_VIEWS)}
      {renderGroup("Analytics & extras", "Reachable through the toolbar’s “More” menu and the command palette.", SECONDARY_VIEWS)}
      <button
        type="button"
        disabled={saving || hidden.size === 0}
        onClick={() => void run(() => setHidden([]))}
        className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 disabled:opacity-40"
        data-testid="view-visibility-show-all"
      >
        Show all views
      </button>
    </div>
  );
}
