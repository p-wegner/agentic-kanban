/**
 * Session persistence: sessions, session_messages and diff_comments reads/writes.
 *
 * FACADE (god-module gate, #875/#888/#889/#45): this module had grown to 728 lines /
 * 33 top-level declarations and was tripping the merge-blocking cohesion gate, so it was
 * split by responsibility into ./session/* and re-exported here — see
 * project-scaffold.ts / stack-profile.service.ts / agent-stream-parser.ts for the same
 * pattern. The PUBLIC export surface is byte-identical (names AND values), so its ~20
 * importers (routes, services, cli/commands/*, tests) are unchanged.
 *
 * The per-session .out transcript readers (readSessionStdoutFile /
 * readSessionStdoutFileTail) are a filesystem ADAPTER, not persistence — they
 * live in lib/session-output-reader.ts so this repository stays pure DB access
 * (enforced by the repositories-are-infra-pure lint:arch rule). Re-exported here
 * for back-compat is intentionally avoided: callers import the adapter directly.
 */

// --- Session lifecycle + identity reads (sessions table) ---
export {
  clearSessionProviderSessionId,
  getSessionWorkspaceId,
  findRunningSession,
  findResumableSession,
  getWorkspaceSessions,
  getWorkspaceSkillName,
  getSessionById,
  getSessionTranscriptContext,
  getLatestSessionIdForWorkspace,
} from "./session/lifecycle.js";

// --- Session messages (session_messages), incl. the .out-file-or-DB reads ---
export {
  loadSessionMessageRowsWithFileFallback,
  getSessionMessageRows,
  getSessionOutput,
  searchTranscriptMessages,
  getNewestSessionMessages,
  getSessionMessagesByIdDesc,
  getSessionMessagesByIdAsc,
} from "./session/messages.js";
export type { TranscriptSearchParams } from "./session/messages.js";

// --- Session stats + summary ---
export {
  getSessionStatus,
  getSessionStatsRaw,
  getSessionStats,
  updateSessionStats,
  getSessionSummaryData,
} from "./session/stats.js";
export type { SessionStatsResult, SessionSummaryResult } from "./session/stats.js";

// --- Analytics / rollup reads (insights, standup, friction backfill, reviewer fixes) ---
export {
  getInsightsSessionRows,
  getSessionsForWorkspacesSince,
  getRecentSessionsWithContext,
  getSessionsForFrictionBackfill,
  getReviewerFixSessionRows,
} from "./session/analytics.js";

// --- Diff comments (diff_comments) ---
export {
  getDiffComments,
  createDiffComment,
  setDiffCommentResolved,
  updateDiffComment,
  findDiffComment,
  deleteDiffComment,
} from "./session/diff-comments.js";
