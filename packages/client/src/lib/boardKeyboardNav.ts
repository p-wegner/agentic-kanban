// Pure cursor-navigation logic for the board's keyboard shortcuts, extracted from
// useBoardKeyboardShortcuts so it can be unit-tested without a DOM or React. Given
// the navigable columns, the current cursor issue id, and the pressed key, it
// returns the issue id the cursor should move to (or null to leave it unchanged).

/** Minimal shape this helper needs from a board column. */
export interface NavColumn {
  issues: { id: string }[];
}

/** Arrow / vim keys that move the keyboard cursor. */
export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "j" | "k" | "h" | "l";

function findCursor(navColumns: NavColumn[], cursorId: string | null): { colIdx: number; issueIdx: number } {
  if (cursorId) {
    for (let c = 0; c < navColumns.length; c++) {
      const i = navColumns[c].issues.findIndex((issue) => issue.id === cursorId);
      if (i !== -1) return { colIdx: c, issueIdx: i };
    }
  }
  return { colIdx: -1, issueIdx: -1 };
}

/**
 * Compute the issue id the cursor should land on for the given key press.
 * Returns null when there is no valid target (and the cursor should stay put).
 * When the cursor isn't currently on any navigable issue, any nav key seeds it
 * onto the first issue of the first non-empty column.
 */
export function computeNavTarget(navColumns: NavColumn[], cursorId: string | null, key: NavKey): string | null {
  const { colIdx, issueIdx } = findCursor(navColumns, cursorId);

  if (colIdx === -1) {
    const firstCol = navColumns.find((c) => c.issues.length > 0);
    return firstCol ? firstCol.issues[0].id : null;
  }

  let newColIdx = colIdx;
  let newIssueIdx = issueIdx;
  if (key === "ArrowDown" || key === "j") {
    if (issueIdx < navColumns[colIdx].issues.length - 1) newIssueIdx = issueIdx + 1;
  } else if (key === "ArrowUp" || key === "k") {
    if (issueIdx > 0) newIssueIdx = issueIdx - 1;
  } else if (key === "ArrowRight" || key === "l") {
    for (let c = colIdx + 1; c < navColumns.length; c++) {
      if (navColumns[c].issues.length > 0) {
        newColIdx = c;
        newIssueIdx = Math.min(issueIdx, navColumns[c].issues.length - 1);
        break;
      }
    }
  } else if (key === "ArrowLeft" || key === "h") {
    for (let c = colIdx - 1; c >= 0; c--) {
      if (navColumns[c].issues.length > 0) {
        newColIdx = c;
        newIssueIdx = Math.min(issueIdx, navColumns[c].issues.length - 1);
        break;
      }
    }
  }

  const target = navColumns[newColIdx]?.issues[newIssueIdx];
  return target ? target.id : null;
}
