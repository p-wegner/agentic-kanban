/**
 * These projections moved to `shared/lib/issue-summary.ts` alongside `loadIssueSummary`
 * (#506) — the MCP tool needs them too, and it cannot import server code. Kept as a
 * re-export so existing server importers and `__tests__/issue-summary-projection.test.ts`
 * are unchanged.
 */
export {
  projectSessionStats,
  computeSessionDuration,
  type IssueSummaryStats,
} from "@agentic-kanban/shared/lib/issue-summary";

/** Parse a session `stats` JSON blob to an object, or null on absent/malformed input. */
export { parseSessionStatsBlob as parseStatsBlob } from "@agentic-kanban/shared";
