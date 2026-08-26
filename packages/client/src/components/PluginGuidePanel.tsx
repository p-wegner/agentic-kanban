import { useEffect, useState } from "react";
import { Icon } from "./Icon.js";

/**
 * Follow the board's theme, which lives as a `dark` class on <html> (useTheme). Read at
 * mount and watched, so toggling the theme re-renders the framed doc without a reload.
 */
export function useBoardIsDark(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [isDark, setIsDark] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(() => setIsDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

/**
 * A plugin VIEW is served from its own process and cannot see the board's `dark` class, so
 * without a hint it can only follow the OS scheme — which is wrong whenever the board's toggle
 * disagrees with it. Tell it, the same way the docs route is told: `?theme=dark|light`. A view
 * that already carries a `theme` param (its own navigation) is left alone.
 */
export function withThemeParam(url: string, isDark: boolean): string {
  try {
    const u = new URL(url, "http://localhost");
    if (u.searchParams.has("theme")) return url;
    u.searchParams.set("theme", isDark ? "dark" : "light");
    return u.toString();
  } catch {
    return url;
  }
}

export function pluginGuideUrl(isDark: boolean, pluginId: string, file: string): string {
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `/api/plugins/${encodeURIComponent(pluginId)}/docs/${path}?theme=${isDark ? "dark" : "light"}`;
}

/**
 * Plugins tab → a plugin-authored doc (manifest `docs[]`, e.g. an overview of how a
 * plugin suite fits together and which part to reach for) rendered INSIDE the board, from
 * the place where those plugins are started. Served from the plugin's own checkout via
 * GET /api/plugins/:id/docs/:file — the board holds no doc and no plugin name of its own.
 */
export function PluginGuidePanel({ pluginId, file, title }: { pluginId: string; file: string; title: string }) {
  const isDark = useBoardIsDark();
  const url = pluginGuideUrl(isDark, pluginId, file);
  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col" data-testid="plugin-guide-panel">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-1.5">
        <div className="text-xs text-gray-600 dark:text-gray-300 truncate">
          📖 {title}
        </div>
        <button
          type="button"
          onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          className="p-1.5 rounded text-gray-500 hover:text-gray-800 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
          title="Open in new tab"
          aria-label="Open guide in new tab"
        >
          <Icon className="h-4 w-4" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
          </Icon>
        </button>
      </div>
      <iframe
        key={url}
        src={url}
        title="Plugin guide"
        className="flex-1 w-full bg-white dark:bg-gray-950"
        sandbox="allow-same-origin allow-popups"
      />
    </div>
  );
}
