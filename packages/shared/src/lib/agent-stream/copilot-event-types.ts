// Single source of truth for Copilot event-type name sets (arch-review #892).
//
// Two parsers consume Copilot JSONL: the live stream parser (./copilot.ts) and
// the offline session-summary parser (../session-summary.ts). Both classify
// events by these normalized type names. They USED to each define their own
// copies of `COPILOT_SESSION_START_TYPES` / `COPILOT_RESULT_TYPES`, and the sets
// had already drifted — a CLI version bump that teaches one parser a new event
// name but not the other silently breaks the summary panel while the live
// terminal keeps working, with no error. Hosting the sets here forces both to
// stay in lockstep; `copilot-event-types-lockstep.test.ts` asserts it.
//
// Type strings are NORMALIZED (lowercased, `-` → `_`) — match the output of the
// `normalizedType()` helper in copilot.ts / session-summary.ts before lookup.

/** Session-start / session-created events that carry the initial model + cwd. */
export const COPILOT_SESSION_START_TYPES = new Set([
  "session_start",
  "session_started",
  "session_created",
  "session.start",
  "session.started",
  "session.created",
]);

/** Turn/session completion events. Note: bare `result` is handled per-provider. */
export const COPILOT_RESULT_TYPES = new Set([
  "result",
  "done",
  "session_end",
  "session_ended",
  "session.end",
  "session.ended",
  "turn_completed",
  "turn.completed",
  "stats",
]);

/** Tool-invocation events (session-summary uses an explicit set; copilot.ts uses substring matching). */
export const COPILOT_TOOL_USE_TYPES = new Set([
  "tool_call",
  "tool_call_start",
  "tool_call_started",
  "tool_use",
  "tool_use_start",
  "tool_use_started",
  "tool.start",
  "tool.started",
  "tool_call.started",
]);

/** Tool-result events (session-summary uses an explicit set; copilot.ts uses substring matching). */
export const COPILOT_TOOL_RESULT_TYPES = new Set([
  "tool_result",
  "tool_call_result",
  "tool_call_complete",
  "tool_call_completed",
  "tool.completed",
  "tool_call.completed",
]);
