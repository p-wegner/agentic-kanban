/**
 * Pure state for the plugin-view iframe host's loading overlay (#1228).
 *
 * The view server answering `/health` is not the same moment as the iframe rendering its
 * first page — measured ~2s apart on the code-metrics Overview view. Swapping "Starting…"
 * for a bare `<iframe>` the instant `/health` answers left the pane BLANK for that gap, with
 * no way to tell a slow view from a broken one. This module tracks the phase between "the
 * src was set" and "the iframe's onLoad fired", plus the timeout-to-retry transition, as a
 * plain reducer so the lifecycle is testable without mounting a real iframe.
 */

export type PluginViewFrameStatus = "loading" | "loaded" | "timed-out" | "start-failed";

export interface PluginViewFrameState {
  status: PluginViewFrameStatus;
  /** The url this state is for — a new url resets to "loading". */
  url: string | null;
}

export type PluginViewFrameEvent =
  | { type: "src-set"; url: string }
  | { type: "frame-loaded"; url: string }
  | { type: "timeout"; url: string }
  | { type: "start-failed" }
  | { type: "retry" };

export const initialPluginViewFrameState: PluginViewFrameState = { status: "loading", url: null };

/**
 * A `frame-loaded`/`timeout` event carries the url it applies to, because a slow start's
 * timer can still fire after the user retried onto a different (or the same, re-started)
 * url — an event for a superseded url must not clobber the newer state, the same staleness
 * shape `createStartLatch` guards on the start-request side.
 */
export function reducePluginViewFrameState(
  state: PluginViewFrameState,
  event: PluginViewFrameEvent,
): PluginViewFrameState {
  switch (event.type) {
    case "src-set":
      return { status: "loading", url: event.url };
    case "frame-loaded":
      if (event.url !== state.url) return state;
      return { status: "loaded", url: state.url };
    case "timeout":
      if (event.url !== state.url || state.status !== "loading") return state;
      return { status: "timed-out", url: state.url };
    case "start-failed":
      return { status: "start-failed", url: null };
    case "retry":
      return { status: "loading", url: null };
    default:
      return state;
  }
}
