// One board-WebSocket → debounced refetch subscription (#514).
//
// Six panels open-coded the same effect: subscribe to BOARD_WS_EVENT on `window`, cast
// the CustomEvent, drop events for other projects, test a private "relevant reasons"
// predicate, trailing-debounce, then call a loader — each with its own timer ref and
// cleanup.
//
// The copies were not identical, and the differences are why this is worth sharing:
//   * debounce ranged 250ms–3s with no stated reason per panel;
//   * some cleared the pending timer on unmount, some did not — a late timer then
//     fetches into an unmounted component;
//   * one re-armed while a fetch was in flight, so a burst could stack overlapping
//     requests whose responses raced on shared refs — the exact bug AgentFlightRecorder's
//     debounce was added to fix, re-introduced elsewhere.
//
// The scheduling logic lives in a plain controller rather than inside the effect so it is
// testable without a DOM renderer: this package has no @testing-library/react (see the
// note in ButlerQuestionCard.test.tsx). The hook is only the wiring.

import { useEffect, useRef } from "react";
import { BOARD_WS_EVENT, type BoardWsEventDetail } from "../lib/useBoardEvents.js";

export interface BoardWsRefreshOptions {
  /** Only events for this project trigger a refresh. A null/undefined id disables. */
  projectId: string | null | undefined;
  /** Which `reason` values this panel cares about. */
  shouldRefetch: (reason: string) => boolean;
  /** The loader. May be async; overlapping calls are prevented. */
  refresh: () => void | Promise<void>;
  /** Trailing debounce window. Default 250ms — a merge cascade emits bursts. */
  debounceMs?: number;
}

export interface BoardWsRefreshController {
  /** Feed one event detail in. Returns true when it was accepted (and scheduled). */
  handleEvent(detail: BoardWsEventDetail | null | undefined): boolean;
  /** Cancel any pending refresh. Idempotent. */
  dispose(): void;
}

interface ControllerTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
}

const DOM_TIMERS: ControllerTimers = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

/**
 * The debounce/coalesce core, free of React and of the DOM event target.
 *
 * Provides the two guarantees the hand-rolled copies did not all have: a pending refresh
 * is dropped on dispose, and a refresh arriving while one is in flight re-arms ONCE
 * instead of stacking.
 */
export function createBoardWsRefreshController(
  options: BoardWsRefreshOptions,
  timers: ControllerTimers = DOM_TIMERS,
): BoardWsRefreshController {
  const { projectId, shouldRefetch, refresh, debounceMs = 250 } = options;

  let timer: number | null = null;
  let inFlight = false;
  let rearmAfterFlight = false;
  let disposed = false;

  const schedule = () => {
    if (timer != null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      if (!disposed) run();
    }, debounceMs);
  };

  const run = () => {
    if (inFlight) {
      // Do not stack: remember that something changed and re-arm once this one lands.
      rearmAfterFlight = true;
      return;
    }
    inFlight = true;
    const settle = () => {
      inFlight = false;
      if (rearmAfterFlight && !disposed) {
        rearmAfterFlight = false;
        schedule();
      }
    };
    let result: void | Promise<void>;
    try {
      // Called SYNCHRONOUSLY, as each hand-rolled copy did — deferring it to a
      // microtask would change when the loader observes state.
      result = refresh();
    } catch {
      // A synchronous throw from the loader must not kill the subscription.
      settle();
      return;
    }
    void Promise.resolve(result)
      .catch(() => {
        // The panel's loader owns its own error surface; swallowing here only stops a
        // fire-and-forget refresh from becoming an unhandled rejection.
      })
      .finally(settle);
  };

  return {
    handleEvent(detail) {
      if (disposed || !projectId) return false;
      if (!detail || detail.projectId !== projectId) return false;
      if (!shouldRefetch(detail.reason)) return false;
      schedule();
      return true;
    },
    dispose() {
      disposed = true;
      if (timer != null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function useBoardWsRefresh(options: BoardWsRefreshOptions): void {
  const { projectId, debounceMs = 250 } = options;

  // Refs so a changing predicate/loader identity does not tear the subscription down and
  // rebuild it on every render — another way the copies differed.
  const shouldRefetchRef = useRef(options.shouldRefetch);
  shouldRefetchRef.current = options.shouldRefetch;
  const refreshRef = useRef(options.refresh);
  refreshRef.current = options.refresh;

  useEffect(() => {
    if (!projectId) return;
    const controller = createBoardWsRefreshController({
      projectId,
      shouldRefetch: (reason) => shouldRefetchRef.current(reason),
      refresh: () => refreshRef.current(),
      debounceMs,
    });
    const onWs = (ev: Event) => {
      controller.handleEvent((ev as CustomEvent<BoardWsEventDetail>).detail);
    };
    window.addEventListener(BOARD_WS_EVENT, onWs);
    return () => {
      window.removeEventListener(BOARD_WS_EVENT, onWs);
      controller.dispose();
    };
  }, [projectId, debounceMs]);
}
