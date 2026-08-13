/**
 * Butler SDK service — a warm, in-process Claude session per project, backed by
 * the Claude Agent SDK (@anthropic-ai/claude-agent-sdk).
 *
 * Why this exists: the previous butler spawned a fresh `claude.exe --resume` per
 * message (cold start every turn) because a warm stdin-open CLI process cannot
 * stream on Windows (claude.exe buffers stdout until stdin closes). The Agent SDK
 * is a library call with a native async-iterator stream, so it stays warm across
 * turns and streams token deltas without any stdio/TTY buffering problem.
 *
 * One session per projectId. Turns are fed into a single `query()` via a pushable
 * AsyncIterable input stream, so conversation context stays warm in-process.
 * Auth/model come from the active Claude profile env (Bedrock/z.ai/API key),
 * reusing `buildSpawnEnv` so the butler behaves like the rest of the agents.
 *
 * FACADE (god-module gate, #875/#888/#889/#465): this module had grown to 1091
 * lines / 39 top-level declarations (over its grandfathered baseline of 30) and
 * was tripping the merge-blocking cohesion gate, so it was split by responsibility
 * into `./butler-sdk/*` and re-exported here — see session.repository.ts /
 * agent-questions.service.ts / stack-profile.service.ts for the same pattern. The
 * PUBLIC export surface is byte-identical (names AND values), so every importer
 * (routes, other services, tests) is unchanged.
 *
 *  - `types`            — shared interfaces/contracts (ButlerSession, ButlerEvent, ...)
 *  - `pushable`          — the queue-backed AsyncIterable feeding the SDK `query()`
 *  - `registry`          — the session map, listener bookkeeping, read-only lookups
 *  - `questions`         — AskUserQuestion parking/answering (#459/#460/#461)
 *  - `system-prompt`     — the butler's system-prompt text
 *  - `codex-provider`    — the codex-backend per-turn subprocess + stream parsing
 *  - `claude-loop`       — the claude-backend SDK message loop + error recovery
 *  - `session-lifecycle` — ensure/stop a session, switch model, interrupt a turn
 *  - `turns`             — dispatch a turn to the active session
 */

export type {
  ButlerCommand,
  ButlerQuestionOption,
  ButlerQuestion,
  ButlerQuestionAnswer,
  ButlerEvent,
  ButlerTurn,
  ButlerSessionState,
} from "./butler-sdk/types.js";

export {
  BUTLER_QUESTION_TIMEOUT_MS,
  NO_INTERACTIVE_CLIENT_MESSAGE,
  QUESTION_TIMED_OUT_MESSAGE,
  normalizeButlerQuestions,
  formatButlerAnswers,
  getButlerCanUseTool,
  answerButlerQuestion,
} from "./butler-sdk/questions.js";

export {
  butlerSessionKey,
  hasInteractiveButlerListener,
  getButlerSession,
  listProjectButlerStates,
  getButlerCommands,
  getButlerTranscript,
  subscribeButler,
} from "./butler-sdk/registry.js";

export {
  ensureButlerSession,
  setButlerModel,
  interruptButler,
  stopButlerSession,
} from "./butler-sdk/session-lifecycle.js";

export { isStaleCodexResumeError } from "./butler-sdk/codex-provider.js";

export { isInvalidThinkingSignatureError } from "./butler-sdk/claude-loop.js";

export { sendButlerTurn } from "./butler-sdk/turns.js";
