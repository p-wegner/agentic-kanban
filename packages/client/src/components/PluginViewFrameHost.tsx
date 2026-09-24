import type { PluginViewFrameState } from "../lib/pluginViewFrameState.js";
import { VIEW_FRAME_LOAD_TIMEOUT_MS } from "../hooks/usePluginViewFrameLifecycle.js";
import { withThemeParam } from "./PluginGuidePanel.js";

interface PluginViewFrameHostProps {
  viewLabel: string;
  pluginName: string;
  activeUrl: string;
  frameKey: number;
  isDark: boolean;
  frameState: PluginViewFrameState;
  frameElapsedSec: number;
  onFrameLoaded: () => void;
  onRetry: () => void;
}

/**
 * The iframe for an active plugin view, plus its loading/timeout overlays (#1228).
 *
 * `/health` answering is not the same moment as the iframe painting its first page —
 * measured 2-2.5s apart on a real view — so swapping straight to a bare iframe left that
 * gap BLANK with no way to tell a slow view from a broken one. This sits over the iframe
 * until `onLoad` fires, or shows a retry notice if it never does within the timeout.
 */
export function PluginViewFrameHost({
  viewLabel,
  pluginName,
  activeUrl,
  frameKey,
  isDark,
  frameState,
  frameElapsedSec,
  onFrameLoaded,
  onRetry,
}: PluginViewFrameHostProps) {
  return (
    <div className="relative flex-1 min-h-0">
      {frameState.status === "loading" && frameState.url === activeUrl && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-950"
          data-testid="plugin-view-loading-overlay"
        >
          <div className="text-center text-sm text-gray-500 dark:text-gray-400">
            <div>Loading {viewLabel}…</div>
            <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              {frameElapsedSec}s
            </div>
          </div>
        </div>
      )}
      {frameState.status === "timed-out" && frameState.url === activeUrl && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-white dark:bg-gray-950 p-6"
          data-testid="plugin-view-timeout-notice"
        >
          <div className="text-center max-w-md">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {viewLabel} is taking longer than expected
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The view server is up, but its page has not loaded after {Math.round(VIEW_FRAME_LOAD_TIMEOUT_MS / 1000)}s.
            </p>
            <button
              onClick={onRetry}
              className="mt-3 text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
            >
              Retry
            </button>
          </div>
        </div>
      )}
      <iframe
        key={`${frameKey}:${isDark}`}
        src={withThemeParam(activeUrl, isDark)}
        title={`${pluginName} — ${viewLabel}`}
        className="h-full w-full bg-white dark:bg-gray-950"
        sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
        // A view is a whole tool inside a panel — a graph, a dashboard — and the panel is
        // the smallest part of the screen. Without this, requestFullscreen() REJECTS in
        // here (permissions policy, nothing to do with sandbox), so a view offering a
        // fullscreen control can only ever fall back to filling its own frame.
        allow="fullscreen"
        onLoad={onFrameLoaded}
      />
    </div>
  );
}

interface PluginViewStartFailedNoticeProps {
  viewLabel: string;
  onRetry: () => void;
}

/** Not-ready notice instead of a blank frame (#1228) — the view server errored on start. */
export function PluginViewStartFailedNotice({ viewLabel, onRetry }: PluginViewStartFailedNoticeProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-6" data-testid="plugin-view-start-failed">
      <div className="text-center max-w-md">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {viewLabel} did not start
        </div>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The view server reported an error instead of coming up. Try again, or check the
          server logs if it keeps failing.
        </p>
        <button
          onClick={onRetry}
          className="mt-3 text-sm px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700"
        >
          Retry
        </button>
      </div>
    </div>
  );
}
