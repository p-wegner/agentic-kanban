import type { IssueWithStatus } from "@agentic-kanban/shared";
import { sortIssues, ISSUE_TYPE_ORDER, type SortMode } from "./columnHelpers.js";

// Pure, React-free sorting/persistence logic for a board column's per-column
// sort mode. Extracted verbatim from BoardColumn.tsx so it can be unit-tested
// in isolation. The actual comparator lives in columnHelpers (`sortIssues` /
// `ISSUE_TYPE_ORDER`); this module owns the column-scoped mode persistence and
// re-exports the comparator pieces so callers have a single sort import point.

export { sortIssues, ISSUE_TYPE_ORDER };
export type { SortMode };

export const VALID_SORT_MODES = new Set<string>(["default", "type"]);

/** localStorage key for a column's persisted sort mode. */
export function sortModeStorageKey(columnId: string): string {
  return `col-sort-${columnId}`;
}

/** Reads the persisted sort mode for a column, defaulting to "default" on any
 *  missing/invalid value or storage error. */
export function loadSortMode(columnId: string): SortMode {
  try {
    const stored = localStorage.getItem(sortModeStorageKey(columnId));
    return (stored && VALID_SORT_MODES.has(stored) ? stored : "default") as SortMode;
  } catch {
    return "default";
  }
}

/** Persists a column's sort mode, swallowing any storage error. */
export function saveSortMode(columnId: string, mode: SortMode): void {
  try {
    localStorage.setItem(sortModeStorageKey(columnId), mode);
  } catch {
    // ignore
  }
}

/** Toggles between the two sort modes. */
export function nextSortMode(mode: SortMode): SortMode {
  return mode === "default" ? "type" : "default";
}

/** Sorts a column's issues for a given sort mode (pure pass-through to the
 *  shared comparator). */
export function sortColumnIssues(issues: IssueWithStatus[], mode: SortMode): IssueWithStatus[] {
  return sortIssues(issues, mode);
}
