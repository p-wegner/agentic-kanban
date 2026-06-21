// Pure board-activity summary string for BoardToolbar. Relocated verbatim from the
// component so the logic (already unit-tested) lives in lib/, not in a component file.

import type { StatusWithIssues } from "@agentic-kanban/shared";

const BOARD_ACTIVITY_STATUS_ORDER = ["In Progress", "In Review", "AI Reviewed", "Todo"];

/**
 * "N In Progress, M In Review, …" — the four workflow statuses first (fixed order),
 * then any other non-empty columns in encounter order; empty columns omitted.
 */
export function formatBoardActivitySummary(activeColumns: StatusWithIssues[]) {
  const columnsByName = new Map(activeColumns.map((col) => [col.name, col]));
  const orderedNames = [
    ...BOARD_ACTIVITY_STATUS_ORDER,
    ...activeColumns.map((col) => col.name).filter((name) => !BOARD_ACTIVITY_STATUS_ORDER.includes(name)),
  ];

  return orderedNames
    .map((name) => columnsByName.get(name))
    .filter((col): col is StatusWithIssues => col !== undefined)
    .filter((col) => col.count > 0)
    .map((col) => `${col.count} ${col.name}`)
    .join(", ");
}
