/**
 * AskUserQuestion parser + per-project listing service — facade barrel.
 *
 * The Claude harness denies the `AskUserQuestion` tool (sandboxed agents have it
 * disabled). The denial surfaces in the session's terminal `result` event as a
 * `permission_denials[*]` entry whose `tool_input.questions` holds the structured
 * multi-choice questions the agent intended to ask. Without a UI to answer, the
 * agent emits a "Waiting on your answers" message and exits — permanently blocked.
 *
 * This service scans completed sessions for those denials, returns the questions
 * as structured records, and tracks per-`tool_use_id` "answered" markers in the
 * preferences table so answered questions stop appearing.
 *
 * Decomposed (#912) into cohesive sub-modules under `./agent-questions/`:
 *  - `types`          — shared interfaces / contracts
 *  - `parsing`        — AskUserQuestion + synthetic-comment payload parsing
 *  - `staleness`      — per-question staleness computation
 *  - `markers`        — answered / dismissed / recommendation prefs + durable comment
 *  - `recommendation` — butler-recommendation pipeline
 *  - `auto-answer`    — background recommend + auto-answer orchestration
 *  - `listing`        — per-project compute-on-read listing + cache
 * The public export surface is preserved here so consumers keep importing from
 * `agent-questions.service.js`.
 */
export type {
  AutoAnswerSendTurn,
  AgentQuestionOption,
  AgentQuestion,
  AgentQuestionRecommendation,
  StalenessReason,
  Staleness,
  PendingQuestionSet,
  StalenessInput,
} from "./agent-questions/types.js";

export { invalidateAgentQuestionsCache } from "./agent-questions/cache.js";

export { extractQuestionsFromSession } from "./agent-questions/parsing.js";

export { computeStaleness } from "./agent-questions/staleness.js";

export {
  isAnswered,
  markAnswered,
  markDismissed,
  writeAgentQuestionComment,
  getCachedRecommendations,
  setCachedRecommendations,
} from "./agent-questions/markers.js";

export {
  extractJsonArray,
  coerceRecommendation,
  recommendQuestionsForSet,
} from "./agent-questions/recommendation.js";

export { tryAutoAnswer, formatAnswerMessage } from "./agent-questions/auto-answer.js";

export { listPendingQuestionsForProject } from "./agent-questions/listing.js";
