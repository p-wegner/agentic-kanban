/**
 * Identifies sessions that are "analytics noise" — meta-sessions representing
 * monitoring, health-check, or board-navigation activities rather than
 * meaningful agent implementation work.
 *
 * Noise sessions are excluded from:
 * - Workspace session counts used for stuck-detection in the monitor cycle
 * - The "latest session" shown in board analytics and CLI status
 * - The "last agent message" displayed per workspace
 *
 * The definition moved to `shared/lib/session-selection.ts` with #506, so that the shared
 * `loadIssueSummary` — which the MCP tool calls, and which cannot import server code —
 * applies the SAME policy the CLI has always applied. Re-exported here because seven
 * server modules import it from this path.
 */
export {
  NOISE_TRIGGER_TYPES,
  isAnalyticsNoise,
} from "@agentic-kanban/shared/lib/session-selection";
