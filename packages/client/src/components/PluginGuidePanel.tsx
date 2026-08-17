import { useEffect, useState } from "react";

/**
 * Follow the board's theme, which lives as a `dark` class on <html> (useTheme). Read at
 * mount and watched, so toggling the theme re-renders the framed doc without a reload.
 */
function useBoardIsDark(): boolean {
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

export function pluginGuideUrl(isDark: boolean, doc: string): string {
  return `/api/docs/plugins/${encodeURIComponent(doc)}?theme=${isDark ? "dark" : "light"}`;
}

/**
 * Plugins tab → "Guide: which plugin when?" — the improvement-system map
 * (docs/plugins/improvement-system-map.html) rendered INSIDE the board, so "when do I
 * reach for the safety net vs code-metrics vs the refactor toolset" is answerable from the
 * place where those plugins are started, not from a file in the repo nobody opens.
 *
 * Only reachable via a doc listed by GET /api/docs/plugins — the server lists a doc only when
 * a plugin it is about is installed, so a board without those (non-public) plugins has no
 * entry and gets 404 on the URL.
 */
export function PluginGuidePanel({ file, title }: { file: string; title: string }) {
  const isDark = useBoardIsDark();
  const url = pluginGuideUrl(isDark, file);
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
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
          </svg>
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
