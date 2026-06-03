import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeEntry,
  canGoBack as coreCanGoBack,
  canGoForward as coreCanGoForward,
  EMPTY_TRAIL,
  goBack as coreGoBack,
  goForward as coreGoForward,
  goTo as coreGoTo,
  remove as coreRemove,
  sanitize,
  visit as coreVisit,
  type TrailEntry,
  type TrailState,
} from "./ticketTrailCore.js";

export type { TrailEntry } from "./ticketTrailCore.js";

// Multi-ticket detail tracking (#383).
//
// The detail panel can only show ONE issue at a time, and opening a new ticket
// (clicking a card, or following a `#N` mention deep inside a description)
// *replaces* the current one — so you lose your place with no way back.
//
// This hook keeps a browser-like navigation trail of the tickets you've opened:
//   - a stack of recently-visited tickets (most-recent first) that survives
//     reloads via localStorage, so "which tickets was I just looking at?" is
//     always answerable;
//   - a back/forward cursor so mention-drilling is reversible (Alt+←/Alt+→).
//
// It stores only ids + a label snapshot; the panel still renders the live issue
// resolved from the board, so data stays fresh. The pure transition logic lives
// in ./ticketTrailCore (unit-tested); this hook is the React shell + persistence.

const STORAGE_KEY = "ticketTrail:v1";

function readStored(): TrailState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_TRAIL;
    return sanitize(JSON.parse(raw));
  } catch {
    return EMPTY_TRAIL;
  }
}

function writeStored(state: TrailState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export interface TicketTrail {
  /** Ordered trail, most-recently-opened first. */
  entries: TrailEntry[];
  /** The id of the currently-active ticket in the trail, or null. */
  activeId: string | null;
  /** Whether a back step is available. */
  canGoBack: boolean;
  /** Whether a forward step is available. */
  canGoForward: boolean;
  /** Record that a ticket was opened/focused (call from the panel's selection effect). */
  visit: (entry: TrailEntry) => void;
  /** Jump directly to a trail entry by id. Returns it so the caller can open it. */
  goTo: (id: string) => TrailEntry | null;
  /** Step back one ticket in history. Returns the entry to open, or null. */
  goBack: () => TrailEntry | null;
  /** Step forward one ticket in history. Returns the entry to open, or null. */
  goForward: () => TrailEntry | null;
  /** Remove a ticket from the trail. Returns the entry that should now be active, or null. */
  remove: (id: string) => TrailEntry | null;
  /** Clear the whole trail. */
  clear: () => void;
}

export function useTicketTrail(): TicketTrail {
  const [state, setState] = useState<TrailState>(() => readStored());
  // Avoid re-persisting on the very first render with the value we just read.
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    writeStored(state);
  }, [state]);

  const visit = useCallback((entry: TrailEntry) => {
    setState((prev) => coreVisit(prev, entry));
  }, []);

  // Apply a transition that also yields a "where to navigate next" entry. We
  // compute the result from the post-transition state synchronously inside the
  // updater so the returned entry always matches what we persist.
  const transition = useCallback(
    (fn: (s: TrailState) => TrailState): TrailEntry | null => {
      let result: TrailEntry | null = null;
      setState((prev) => {
        const next = fn(prev);
        result = activeEntry(next);
        return next;
      });
      return result;
    },
    [],
  );

  const goTo = useCallback((id: string) => transition((s) => coreGoTo(s, id)), [transition]);
  const goBack = useCallback(() => transition(coreGoBack), [transition]);
  const goForward = useCallback(() => transition(coreGoForward), [transition]);
  const remove = useCallback((id: string) => transition((s) => coreRemove(s, id)), [transition]);
  const clear = useCallback(() => setState(EMPTY_TRAIL), []);

  const active = activeEntry(state);
  const back = coreCanGoBack(state);
  const forward = coreCanGoForward(state);

  return useMemo(
    () => ({
      entries: state.entries,
      activeId: active?.id ?? null,
      canGoBack: back,
      canGoForward: forward,
      visit,
      goTo,
      goBack,
      goForward,
      remove,
      clear,
    }),
    [state.entries, active?.id, back, forward, visit, goTo, goBack, goForward, remove, clear],
  );
}
