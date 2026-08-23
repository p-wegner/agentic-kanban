import { useEffect, useRef, useState } from "react";
import { usePluginDocs } from "../hooks/usePluginDocs.js";
import { apiFetch } from "../lib/api.js";
import { usePluginViewStore } from "../stores/pluginViewStore.js";
import type { ViewDescriptor, ViewMode } from "../lib/viewRegistry.js";
import { useDismissable } from "../hooks/useDismissable.js";
import { Icon } from "./Icon.js";

// Mirrors BoardToolbar's tab styling constants (kept local — BoardToolbar imports us).
const ACTIVE_DEFAULT = "bg-brand-600 text-white hover:bg-brand-700";
const INACTIVE = "text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-700";
const MENU_ITEM_INACTIVE =
  "text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800";

type PluginListItem = {
  id: string;
  /** Manifest slug (the plugins table's plugin_id). */
  pluginId: string;
  name: string;
  enabled?: boolean;
};

interface PluginViewsTabProps {
  view: ViewDescriptor;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  projectId: string | null;
  /** Rendered inside the hidden measurement row — inert, but same intrinsic width. */
  measuring?: boolean;
}

/**
 * The toolbar's "Plugins" tab — a menu, not a plain tab: it lists every plugin
 * enabled for the project (each opening that plugin's own view), plus entries to
 * install a plugin and browse the marketplace. Clicking the tab always opens the
 * menu; the view switch happens when a menu item is picked.
 */
export function PluginViewsTab({ view, viewMode, onViewModeChange, projectId, measuring }: PluginViewsTabProps) {
  const [open, setOpen] = useState(false);
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  /** Docs the INSTALLED plugins declare (manifest `docs[]`) — nothing without a plugin. */
  const docs = usePluginDocs(open);
  const wrapRef = useRef<HTMLDivElement>(null);
  const selection = usePluginViewStore((s) => s.selection);
  const setSelection = usePluginViewStore((s) => s.setSelection);
  const openMarketplace = usePluginViewStore((s) => s.openMarketplace);

  const isActive = viewMode === view.id;
  const activeClass = view.activeClass ?? ACTIVE_DEFAULT;

  // Refresh the enabled-plugin list each time the menu opens — installs/enables
  // happen in the marketplace right next door, so a mount-time snapshot goes stale.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    apiFetch<PluginListItem[]>(`/api/plugins?projectId=${encodeURIComponent(projectId)}`)
      .then((rows) => {
        if (!cancelled) setPlugins(rows.filter((r) => r.enabled));
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      });
    return () => { cancelled = true; };
  }, [open, projectId]);

  useDismissable(wrapRef, open, () => setOpen(false));

  const tabButton = (
    <button
      onClick={measuring ? undefined : () => setOpen((v) => !v)}
      tabIndex={measuring ? -1 : undefined}
      aria-haspopup={measuring ? undefined : "menu"}
      aria-expanded={measuring ? undefined : open}
      className={`relative px-2.5 py-1 text-xs rounded flex items-center gap-1.5 whitespace-nowrap transition-colors ${isActive ? activeClass : INACTIVE}`}
      title={measuring ? undefined : view.tooltip}
      data-testid={measuring ? undefined : "plugin-views-tab"}
    >
      {view.icon}
      {view.toolbarLabel}
      <Icon className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} d="M6 9l6 6 6-6" />
    </button>
  );

  if (measuring) return tabButton;

  function pick(action: () => void) {
    action();
    onViewModeChange(view.id);
    setOpen(false);
  }

  return (
    <div className="relative" ref={wrapRef}>
      {tabButton}
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 mt-1 max-h-[70vh] w-56 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-20 p-1"
          data-testid="plugin-views-menu"
        >
          {plugins.length === 0 && (
            <div className="px-2.5 py-1.5 text-xs text-gray-400 dark:text-gray-500">
              No plugins enabled for this project
            </div>
          )}
          {plugins.map((plugin) => {
            const active = isActive && selection?.kind === "plugin" && selection.slug === plugin.pluginId;
            return (
              <button
                key={plugin.pluginId}
                role="menuitem"
                onClick={() => pick(() => setSelection({ kind: "plugin", slug: plugin.pluginId }))}
                className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 transition-colors ${active ? activeClass : MENU_ITEM_INACTIVE}`}
                title={plugin.pluginId}
              >
                <span aria-hidden="true">🧩</span>
                <span className="flex-1 truncate">{plugin.name}</span>
              </button>
            );
          })}
          <div className="my-1 border-t border-gray-200 dark:border-gray-700" role="separator" />
          <button
            role="menuitem"
            onClick={() => pick(() => openMarketplace({ focusInstall: true }))}
            className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 transition-colors ${MENU_ITEM_INACTIVE}`}
          >
            <span aria-hidden="true">＋</span>
            <span className="flex-1">Install plugin…</span>
          </button>
          <button
            role="menuitem"
            onClick={() => pick(() => openMarketplace())}
            className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 transition-colors ${
              isActive && selection?.kind === "marketplace" ? activeClass : MENU_ITEM_INACTIVE
            }`}
          >
            <span aria-hidden="true">🛍️</span>
            <span className="flex-1">Marketplace</span>
          </button>
          {docs.map((doc) => (
            <button
              key={`${doc.pluginId}:${doc.file}`}
              role="menuitem"
              onClick={() => pick(() => setSelection({ kind: "guide", pluginId: doc.pluginId, file: doc.file, title: doc.title }))}
              className={`w-full text-left px-2.5 py-1.5 text-xs rounded flex items-center gap-2 transition-colors ${
                isActive && selection?.kind === "guide" && selection.pluginId === doc.pluginId && selection.file === doc.file ? activeClass : MENU_ITEM_INACTIVE
              }`}
              title={doc.description ?? `${doc.pluginName} — ${doc.title}`}
              data-testid="plugin-guide-menu-item"
            >
              <span aria-hidden="true">📖</span>
              <span className="flex-1 truncate">{doc.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
