import { useEffect, useState } from "react";
import {
  initialPluginViewFrameState,
  reducePluginViewFrameState,
  type PluginViewFrameState,
} from "../lib/pluginViewFrameState.js";

/**
 * How long the overlay waits for the iframe's `onLoad` before showing a retry notice
 * instead of leaving the operator staring at an indefinite "Starting…" (#1228). Measured
 * gap between `/health` answering and first paint was 2.0-2.5s on the code-metrics view;
 * this is deliberately generous so a merely-slow view (cold Node start, a heavy first
 * bundle) is never mistaken for a broken one.
 */
export const VIEW_FRAME_LOAD_TIMEOUT_MS = 20_000;

/**
 * Overlay lifecycle for the active plugin-view iframe (#1228).
 *
 * A new `activeUrl` (or a Refresh bump of `frameKey`) begins "loading" and arms a timeout
 * plus a once-a-second elapsed-time ticker; the iframe's own `onLoad` handler (returned as
 * `onFrameLoaded`) dispatches "frame-loaded" and clears both. Both are keyed to the exact
 * url so a stale timer or a stale onLoad from a superseded/refreshed frame is a no-op
 * (mirrors the start-request staleness `createStartLatch` guards on the other side of this
 * flow). The ticker also stops the instant the frame loads — before that it re-rendered the
 * whole panel once a second for as long as the view stayed open.
 */
export function usePluginViewFrameLifecycle(activeUrl: string | null, frameKey: number) {
  const [frameState, setFrameState] = useState<PluginViewFrameState>(initialPluginViewFrameState);
  const [frameElapsedSec, setFrameElapsedSec] = useState(0);

  useEffect(() => {
    if (!activeUrl) return;
    setFrameState({ status: "loading", url: activeUrl });
    setFrameElapsedSec(0);
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      setFrameState((s) => reducePluginViewFrameState(s, { type: "timeout", url: activeUrl }));
    }, VIEW_FRAME_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // frameKey is intentionally in the deps: a Refresh of the SAME url must re-arm the
    // overlay and its timeout too, which a url-only dependency would miss.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUrl, frameKey]);

  // Elapsed-seconds ticker, separate from the effect above so it can also stop the moment
  // the frame loads (#1228) — previously it was cleared only on url/frameKey change, so a
  // loaded view kept re-rendering the whole panel once a second for as long as it stayed
  // open.
  useEffect(() => {
    if (!activeUrl || frameState.status !== "loading") return;
    const startedAt = Date.now();
    const ticker = window.setInterval(() => {
      setFrameElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(ticker);
  }, [activeUrl, frameKey, frameState.status]);

  function markStartFailed() {
    setFrameState({ status: "start-failed", url: null });
  }

  function beginRetry() {
    setFrameState({ status: "loading", url: null });
  }

  function onFrameLoaded(url: string) {
    setFrameState((s) => reducePluginViewFrameState(s, { type: "frame-loaded", url }));
  }

  return { frameState, frameElapsedSec, markStartFailed, beginRetry, onFrameLoaded };
}
