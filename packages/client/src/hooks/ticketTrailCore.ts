// Pure state-transition logic for the multi-ticket navigation trail (#383).
//
// Kept free of React so it can be unit-tested directly (the client test setup
// renders via react-dom/server and has no DOM/renderHook). `useTicketTrail`
// wraps these in component state.

export interface TrailEntry {
  id: string;
  /** Issue number snapshot for the chip label (may be null for number-less issues). */
  number: number | null;
  /** Title snapshot for the chip tooltip / fallback label. */
  title: string;
}

export interface TrailState {
  entries: TrailEntry[];
  /** Index into `entries` of the currently-active ticket, or -1 when none open. */
  cursor: number;
}

export const MAX_TRAIL_ENTRIES = 12;

export const EMPTY_TRAIL: TrailState = { entries: [], cursor: -1 };

/** Record a visited/focused ticket: move it to the front and make it active. */
export function visit(state: TrailState, entry: TrailEntry): TrailState {
  // Already the active entry → just refresh its label snapshot in place.
  if (state.cursor >= 0 && state.entries[state.cursor]?.id === entry.id) {
    const entries = state.entries.slice();
    entries[state.cursor] = { ...entry };
    return { entries, cursor: state.cursor };
  }
  // Move-to-front: drop any existing copy, unshift the fresh visit, reset the
  // cursor to the front. Keeps the trail a true recency list while back/forward
  // still walks the ordered stack.
  const without = state.entries.filter((e) => e.id !== entry.id);
  const entries = [{ ...entry }, ...without].slice(0, MAX_TRAIL_ENTRIES);
  return { entries, cursor: 0 };
}

/** Jump directly to a trail entry by id (no-op if absent). */
export function goTo(state: TrailState, id: string): TrailState {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return state;
  return { entries: state.entries, cursor: idx };
}

/** Step one ticket *older* in history (cursor moves toward the tail). */
export function goBack(state: TrailState): TrailState {
  const next = state.cursor + 1;
  if (next >= state.entries.length) return state;
  return { entries: state.entries, cursor: next };
}

/** Step one ticket *newer* in history (cursor moves toward the front). */
export function goForward(state: TrailState): TrailState {
  const next = state.cursor - 1;
  if (next < 0) return state;
  return { entries: state.entries, cursor: next };
}

/** Remove a ticket from the trail, keeping the cursor pointed sensibly. */
export function remove(state: TrailState, id: string): TrailState {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return state;
  const entries = state.entries.filter((e) => e.id !== id);
  let cursor = state.cursor;
  if (idx === state.cursor) {
    // Removed the active ticket: fall through to the next-most-recent.
    cursor = Math.min(idx, entries.length - 1);
  } else if (idx < state.cursor) {
    cursor -= 1;
  }
  return { entries, cursor };
}

export function activeEntry(state: TrailState): TrailEntry | null {
  return state.cursor >= 0 ? state.entries[state.cursor] ?? null : null;
}

export function canGoBack(state: TrailState): boolean {
  return state.cursor >= 0 && state.cursor < state.entries.length - 1;
}

export function canGoForward(state: TrailState): boolean {
  return state.cursor > 0;
}

/** Defensive parse of a persisted trail (truncates, validates the cursor). */
export function sanitize(raw: unknown): TrailState {
  if (!raw || typeof raw !== "object") return EMPTY_TRAIL;
  const candidate = raw as Partial<TrailState>;
  if (!Array.isArray(candidate.entries)) return EMPTY_TRAIL;
  const entries = candidate.entries
    .filter((e): e is TrailEntry => !!e && typeof (e as TrailEntry).id === "string")
    .slice(0, MAX_TRAIL_ENTRIES);
  const cursor =
    typeof candidate.cursor === "number" && candidate.cursor >= 0 && candidate.cursor < entries.length
      ? candidate.cursor
      : entries.length > 0
        ? 0
        : -1;
  return { entries, cursor };
}
