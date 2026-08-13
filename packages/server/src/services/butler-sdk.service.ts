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
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { query, type CanUseTool, type Options, type PermissionResult, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { buildSpawnEnv, getMcpServersConfig } from "./agent-provider/helpers.js";
import { ensureBoardGuideFile } from "../butler/board-guide.js";
import { isTransientNetworkError } from "../startup/transient-errors.js";
import { getProvider, type ProviderId, type ProviderName } from "./agent-provider.js";
import { classifyButlerLoopError } from "../lib/butler-loop-classify.js";

/** Compact slash-command descriptor surfaced to the UI autocomplete. */
export interface ButlerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/** One selectable choice of an AskUserQuestion question. */
export interface ButlerQuestionOption {
  label: string;
  description?: string;
}

/** One question of an AskUserQuestion call, normalised for the chat UI. */
export interface ButlerQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ButlerQuestionOption[];
}

/** The user's answer to one question (one entry for single-select, N for multi). */
export interface ButlerQuestionAnswer {
  question: string;
  header: string;
  answers: string[];
}

export type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; toolId?: string; input?: Record<string, unknown> }
  | { type: "tool-result"; toolId?: string; output?: string; isError?: boolean }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "meta"; model?: string; contextWindow?: number; mcpConnected?: boolean }
  /** The butler asked a structured question; the chat renders choice chips for it. */
  | { type: "question"; askId: string; questions: ButlerQuestion[] }
  /** The parked question is over — answered by the user, or denied (timeout/abort/stop). */
  | { type: "question-resolved"; askId: string; answers?: ButlerQuestionAnswer[]; reason?: string }
  | { type: "error"; message: string };

type Listener = (e: ButlerEvent) => void;

/** A persisted conversation turn, replayed when the chat UI reloads. */
export interface ButlerTurn {
  role: "user" | "assistant" | "question";
  text: string;
  ts: number;
  /** Only for role "question": the asked questions plus what the user picked.
   *  Only ANSWERED questions are recorded, so a reload never resurrects a parked
   *  question as answerable (its turn is long gone — #460). */
  question?: { askId: string; questions: ButlerQuestion[]; answers: ButlerQuestionAnswer[] };
}

/** Queue-backed AsyncIterable: push() enqueues a turn, end() closes the stream. */
class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.waiting) {
      this.waiting({ value: item, done: false });
      this.waiting = undefined;
    } else {
      this.queue.push(item);
    }
  }

  end(): void {
    this.closed = true;
    if (this.waiting) {
      this.waiting({ value: undefined, done: true });
      this.waiting = undefined;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

interface ButlerSession {
  projectId: string;
  /** Which butler (definition id) this session belongs to. "default" is the
   *  legacy/always-present butler; others are user-defined named butlers. */
  butlerId: string;
  /** Composite map key: plain projectId for the default butler (backward compat),
   *  `${projectId}::${butlerId}` for any other. */
  key: string;
  backend: "claude" | "codex" | "mock";
  input?: Pushable<SDKUserMessage>;
  sessionId?: string;
  abort: AbortController;
  process?: ChildProcess;
  interrupted?: boolean;
  busy: boolean;
  contextTokens: number;
  transcript: ButlerTurn[];
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  /** The active Claude profile this session was started with (per-project override or global). */
  claudeProfile?: string;
  /** Live Query handle — exposes control requests (setModel, supportedCommands). */
  query?: Query;
  /** Slash commands available to this session, fetched once after init (for the UI autocomplete). */
  commands?: ButlerCommand[];
  repoPath: string;
  systemPromptAppend: string;
  profile?: { provider: ProviderName; name: string };
  agentCommand?: string;
  agentArgs?: string;
  /** For a codex butler running under an OAuth license: the CODEX_HOME dir to spawn
   *  under (its own auth.json + rollouts). Set when `profile` was reduced to "default". */
  codexHome?: string;
  /** AskUserQuestion calls parked waiting for a human answer, keyed by askId. */
  pendingQuestions: Map<string, PendingButlerQuestion>;
}

/** A parked AskUserQuestion: the SDK turn is suspended on `settle`. */
interface PendingButlerQuestion {
  askId: string;
  questions: ButlerQuestion[];
  /** The raw AskUserQuestion tool input, kept so the answer can be shaped from it. */
  input: Record<string, unknown>;
  /** Resolves the canUseTool promise exactly once and clears the timer/abort hook. */
  settle: (result: PermissionResult) => void;
}

/**
 * Sessions keyed by a composite of project + butler. The default butler keeps the
 * plain projectId as its key so existing in-memory/resume behavior is unchanged;
 * named butlers use `${projectId}::${butlerId}`.
 */
const sessions = new Map<string, ButlerSession>();

/** Composite session/listener key. Default butler → plain projectId (backward compat). */
export function butlerSessionKey(projectId: string, butlerId: string = "default"): string {
  return butlerId && butlerId !== "default" ? `${projectId}::${butlerId}` : projectId;
}

/**
 * SSE listeners keyed by the same composite key as sessions, kept SEPARATE from the
 * session lifecycle. A stream connects once and must keep receiving events across
 * "clear context" and profile switches, which stop+recreate the underlying session.
 * If listeners lived on the session, reconnecting the stream while no session exists
 * (the gap between stop and the next message) would silently drop the listener and
 * the stream would go dead. Keeping them here means a stream stays attached regardless.
 */
const listenersByKey = new Map<string, Set<Listener>>();

/**
 * The subset of {@link listenersByKey} that is a HUMAN — i.e. the SSE stream behind an
 * open Butler chat tab. Kept separate because "is a listener attached" is not the same
 * question as "can somebody answer" (#461): `POST /:id/butler/ask` and `startSession`
 * subscribe internal listeners too, and counting those would make the synchronous
 * CLI/MCP door — where the caller is blocked waiting for ONE answer and no UI exists —
 * look interactive, park the question, and hang it for the full timeout.
 * Non-interactive is the default; only the stream route opts in.
 */
const interactiveListenersByKey = new Map<string, Set<Listener>>();

function broadcast(s: ButlerSession, e: ButlerEvent): void {
  const ls = listenersByKey.get(s.key);
  if (!ls) return;
  for (const l of ls) {
    try {
      l(e);
    } catch (err) {
      console.error(`[butler-sdk] listener error: project=${s.projectId} butler=${s.butlerId}`, err);
    }
  }
}

// ── AskUserQuestion: park it for the human instead of auto-denying (#459/#460) ──
//
// The butler runs the Agent SDK with the `claude_code` system-prompt preset, which
// advertises `AskUserQuestion`. Without a `canUseTool` handler the SDK auto-denies
// every such call and hands the model an is_error tool_result whose whole content is
// the permission-prompt title ("Answer questions?") — an opaque failure the user sees
// as a red tool card, and which the model then works around by re-asking in prose
// (#459, measured on butler session 32280042-19e3-4a74-b9e4-59924a25cb5a).
//
// The butler is the ONE agent surface with a human at the keyboard, so instead we park
// the call, broadcast the questions to the chat, and resolve when the user answers.

/** How long a parked question waits for a human before it is denied (#461). */
export const BUTLER_QUESTION_TIMEOUT_MS = 10 * 60_000;

/** Denial handed to the model when nothing can render the question (#461). */
export const NO_INTERACTIVE_CLIENT_MESSAGE =
  "No interactive client is attached to this butler session, so this question cannot be answered. " +
  "Ask your question in plain text in your reply instead, or state your assumption and proceed.";

/** Denial handed to the model when the human never answered (#461). */
export const QUESTION_TIMED_OUT_MESSAGE =
  "The question timed out — nobody answered it. Ask in plain text in your reply instead, " +
  "or state your assumption and proceed.";

/** True when at least one HUMAN SSE stream (an open Butler chat tab) is attached. */
export function hasInteractiveButlerListener(projectId: string, butlerId: string = "default"): boolean {
  return (interactiveListenersByKey.get(butlerSessionKey(projectId, butlerId))?.size ?? 0) > 0;
}

/** Coerce the AskUserQuestion tool input into the shape the chat UI renders. */
export function normalizeButlerQuestions(input: Record<string, unknown>): ButlerQuestion[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: ButlerQuestion[] = [];
  for (const q of raw.slice(0, 4)) {
    const item = q as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    const question = typeof item.question === "string" ? item.question : "";
    if (!question) continue;
    const options: ButlerQuestionOption[] = Array.isArray(item.options)
      ? item.options
          .map((o) => o as { label?: unknown; description?: unknown })
          .filter((o) => typeof o.label === "string" && o.label.length > 0)
          .map((o) => ({ label: o.label as string, description: typeof o.description === "string" ? o.description : undefined }))
      : [];
    out.push({
      question,
      header: typeof item.header === "string" && item.header ? item.header : question.slice(0, 12),
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return out;
}

/** Human-readable rendering of the answers, used for the transcript entry. */
export function formatButlerAnswers(answers: ButlerQuestionAnswer[]): string {
  return answers.map((a) => `${a.header}: ${a.answers.join(", ")}`).join("\n");
}

/**
 * Park an AskUserQuestion call until a human answers it (or it is denied).
 * Resolves the `canUseTool` promise the SDK is awaiting.
 */
function askButlerQuestion(
  session: ButlerSession,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const questions = normalizeButlerQuestions(input);
  if (questions.length === 0) {
    return Promise.resolve({ behavior: "deny", message: "The question payload was empty or malformed." });
  }
  // #461 — the guard that makes parking safe. The butler is reachable from surfaces
  // where NOBODY can answer: `POST /:id/butler/ask` (the synchronous CLI/MCP door,
  // whose caller is blocked on one answer), a Butler view with no tab open, a
  // scheduled turn. Parking there would hang until the abort or the timeout, which is
  // strictly worse than the instant failure this ticket set out to fix. So deny at
  // once, with a message that names the remedy — one turn, once, instead of the model
  // re-discovering the same wall (which is exactly what "Answer questions?" caused).
  if (!hasInteractiveButlerListener(session.projectId, session.butlerId)) {
    return Promise.resolve({ behavior: "deny", message: NO_INTERACTIVE_CLIENT_MESSAGE });
  }
  const askId = randomUUID();
  return new Promise<PermissionResult>((resolve) => {
    let settled = false;
    const settle = (result: PermissionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      session.pendingQuestions.delete(askId);
      resolve(result);
    };
    const onAbort = (): void => {
      broadcast(session, { type: "question-resolved", askId, reason: "interrupted" });
      settle({ behavior: "deny", message: "The turn was interrupted before the question could be answered." });
    };
    const timer = setTimeout(() => {
      broadcast(session, { type: "question-resolved", askId, reason: "timeout" });
      settle({ behavior: "deny", message: QUESTION_TIMED_OUT_MESSAGE });
    }, BUTLER_QUESTION_TIMEOUT_MS);
    // Node keeps the process alive for a pending timer; a 10-minute question must not.
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    session.pendingQuestions.set(askId, { askId, questions, input, settle });
    broadcast(session, { type: "question", askId, questions });
  });
}

/**
 * `canUseTool` for the butler. Every tool other than AskUserQuestion keeps the
 * pre-existing behaviour (allowed — the butler runs with `bypassPermissions`
 * because there is no human approving filesystem prompts); only AskUserQuestion
 * is routed to the chat UI.
 */
function butlerCanUseTool(session: ButlerSession): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
    return askButlerQuestion(session, input, options.signal);
  };
}

/**
 * The `canUseTool` handler of a live session — the same closure the SDK holds.
 * Exposed so the deny/park/answer paths can be exercised without a real SDK query.
 */
export function getButlerCanUseTool(projectId: string, butlerId: string = "default"): CanUseTool | undefined {
  const session = sessions.get(butlerSessionKey(projectId, butlerId));
  return session ? butlerCanUseTool(session) : undefined;
}

/**
 * Turn the user's answers into the `PermissionResult` the SDK is awaiting.
 *
 * `PermissionResult` is only `allow | deny` (sdk.d.ts:1993), so an answered question
 * had two candidate encodings. Which one is used here was MEASURED, not guessed:
 *
 *  1. `{behavior:"allow", updatedInput:{...input, answers}}` — **this one. VERIFIED**
 *     end-to-end on 2026-08-13 against the live `mealplan` butler (Opus, Agent SDK
 *     0.3.152): the butler was asked to call AskUserQuestion for a colour, the card
 *     was answered "Green" in the chat, and the butler continued the SAME turn with
 *     `PICKED=Green`. So the CLI's own AskUserQuestion implementation DOES accept
 *     pre-filled answers headlessly — it does not re-prompt and does not hang. The
 *     tool therefore completes normally and its real `AskUserQuestionOutput`
 *     (`{questions, answers}`, sdk-tools.d.ts:2768) reaches the model.
 *  2. `{behavior:"deny", message:"<the user's answer text>"}` — REJECTED. It would
 *     also reach the model (a deny message becomes the tool_result), but only by
 *     recording an answered question as a DENIED tool call: the chat would show a red
 *     error card, the transcript would claim a refusal that never happened, and the
 *     model would have to infer that a denial is really an answer. Since (1) was
 *     measured to work, paying that cost is unjustifiable.
 *
 * `answers` is keyed by question TEXT with multi-select answers comma-joined, which
 * is the shape `AskUserQuestionOutput.answers` declares.
 */
function buildAnsweredPermissionResult(
  pending: PendingButlerQuestion,
  answers: ButlerQuestionAnswer[],
): PermissionResult {
  const byQuestion: Record<string, string> = {};
  for (const a of answers) byQuestion[a.question] = a.answers.join(", ");
  return { behavior: "allow", updatedInput: { ...pending.input, answers: byQuestion } };
}

/**
 * Answer a parked question. Returns false when no such question is parked
 * (already answered, timed out, or the session was recreated).
 */
export function answerButlerQuestion(
  projectId: string,
  askId: string,
  answers: ButlerQuestionAnswer[],
  butlerId: string = "default",
): boolean {
  const session = sessions.get(butlerSessionKey(projectId, butlerId));
  const pending = session?.pendingQuestions.get(askId);
  if (!session || !pending) return false;
  session.transcript.push({
    role: "question",
    text: formatButlerAnswers(answers),
    ts: Date.now(),
    question: { askId, questions: pending.questions, answers },
  });
  broadcast(session, { type: "question-resolved", askId, answers });
  pending.settle(buildAnsweredPermissionResult(pending, answers));
  return true;
}

/** Deny every parked question of a session (teardown / stop). */
function rejectPendingQuestions(session: ButlerSession, message: string): void {
  for (const pending of [...session.pendingQuestions.values()]) {
    broadcast(session, { type: "question-resolved", askId: pending.askId, reason: "cancelled" });
    pending.settle({ behavior: "deny", message });
  }
  session.pendingQuestions.clear();
}

function buildButlerSystemPrompt(projectName: string, repoPath: string): string {
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  const boardGuidePath = ensureBoardGuideFile();
  return [
    `You are the project butler for "${projectName}" — a persistent, warm assistant embedded in the agentic-kanban board.`,
    `Project location: ${repoPath}`,
    `Board API: http://localhost:${serverPort}/api`,
    `Answer questions about the project, codebase, and active work. Help with quick analysis, research, and code questions. Orchestrate work through the board and ensure the kanban workflow is followed.`,
    `For anything about the board (issues, statuses, counts, workspaces, sessions), use the "agentic-kanban" MCP tools (e.g. list_issues, get_board_status, get_issue) — they are authoritative. Do NOT guess board state or scrape it via curl.`,
    `This project may be MULTI-REPO: one LEADING repo (the project's registered repoPath, the agent's starting worktree) plus additional SIBLING repos. Every workspace gets a worktree on the same branch in each repo and merge lands each repo with commits. To BUILD a multi-repo project when the user gives you several git paths: call register_project for the leading repo (its returned id), then add_project_repo({ projectId, path }) once per sibling. Use list_project_repos to inspect the set and remove_project_repo to detach one. A sibling can also take a per-repo setupScript/composeFile. Confirm the result with list_project_repos and report the real repo set.`,
    `For questions about how a previous ticket was implemented, what an agent did, or what problems it hit, use search_sessions to find matching transcript snippets, then get_session_transcript for the relevant session id when more detail is needed.`,
    `For "how does X work?" or architecture/behavior questions about this project, first use openspec_list_specs and show_spec. Answer from the living spec when a relevant domain exists, and cite the spec path/domain in your answer. If no relevant living spec exists, say that and then inspect code or docs as needed.`,
    `The user operates the board in the app's UI (clicking buttons), not the API. For "how do I…/how does X work" board questions, answer with simple UI steps (which tab/button) — a UI how-to is bundled at ${boardGuidePath}; READ it first and answer from it, don't dump API/tool names.`,
    `To start/launch work on an issue, use the board's one-step flow: POST http://localhost:${serverPort}/api/workspaces with { "issueId", "branch": "feature/ak-<n>-<slug>" }. It creates the worktree, moves the issue to In Progress, and launches the agent. Do NOT use start_workspace (it does not launch an agent), and never create worktrees/branches or run claude yourself.`,
    `Never claim an action succeeded (launched, moved, merged) unless the board confirms it — re-check with get_issue/get_board_status and report the real result; if unsure, say so.`,
    `Scope of direct edits: you may edit frontend code (packages/client/**) and documentation (*.md, docs/**, .claude/**) directly. Do NOT directly edit backend code (packages/server/**, packages/shared/**, packages/mcp-server/**) — the server hot-reloads on file changes and that would terminate your own process mid-turn. For any backend change, create a kanban ticket via the MCP create_issue tool describing the change instead of editing the files; tell the user a ticket was created and reference its number. This applies even for one-line backend tweaks the user asks you to "just do".`,
    `Be concise and helpful; avoid unnecessary preamble. You have full read access to the project files and standard tools.`,
  ].join("\n");
}

export interface ButlerSessionState {
  butlerId: string;
  backend: "claude" | "codex" | "mock";
  sessionId?: string;
  active: boolean;
  busy: boolean;
  contextTokens: number;
  model?: string;
  contextWindow?: number;
  mcpConnected?: boolean;
  claudeProfile?: string;
}

export function getButlerSession(projectId: string, butlerId: string = "default"): ButlerSessionState {
  const s = sessions.get(butlerSessionKey(projectId, butlerId));
  return { butlerId, backend: s?.backend ?? "claude", sessionId: s?.sessionId, active: !!s, busy: s?.busy ?? false, contextTokens: s?.contextTokens ?? 0, model: s?.model, contextWindow: s?.contextWindow, mcpConnected: s?.mcpConnected, claudeProfile: s?.claudeProfile };
}

/** Runtime state of every warm butler session for a project (for the butler switcher). */
export function listProjectButlerStates(projectId: string): ButlerSessionState[] {
  const out: ButlerSessionState[] = [];
  for (const s of sessions.values()) {
    if (s.projectId !== projectId) continue;
    out.push({ butlerId: s.butlerId, backend: s.backend, sessionId: s.sessionId, active: true, busy: s.busy, contextTokens: s.contextTokens, model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected, claudeProfile: s.claudeProfile });
  }
  return out;
}

/** Slash commands the active session reported as available (empty if none/not yet fetched). */
export function getButlerCommands(projectId: string, butlerId: string = "default"): ButlerCommand[] {
  return sessions.get(butlerSessionKey(projectId, butlerId))?.commands ?? [];
}

/**
 * Switch the model for subsequent turns WITHOUT restarting — uses the SDK's
 * `query.setModel()` control request, so conversation context is preserved.
 * Returns false if there is no active session. An empty string clears the
 * override (back to the profile/CLI default).
 */
export async function setButlerModel(projectId: string, model: string, butlerId: string = "default"): Promise<boolean> {
  const s = sessions.get(butlerSessionKey(projectId, butlerId));
  if (s?.backend === "codex") {
    s.model = model || undefined;
    broadcast(s, { type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
    return true;
  }
  if (!s?.query) return false;
  await s.query.setModel(model || undefined);
  s.model = model || undefined;
  broadcast(s, { type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
  return true;
}

/**
 * Interrupt the butler's in-flight turn (the SDK's `query.interrupt()` control request),
 * without tearing down the warm session — the next turn can still be sent. Returns false
 * if there is no active session/query. Broadcasts a result so the UI leaves its "thinking"
 * state even if the SDK does not emit its own interrupt result.
 */
export async function interruptButler(projectId: string, butlerId: string = "default"): Promise<boolean> {
  const s = sessions.get(butlerSessionKey(projectId, butlerId));
  if (s?.backend === "codex") {
    s.interrupted = true;
    if (s.process?.pid) s.process.kill();
    s.process = undefined;
    s.busy = false;
    broadcast(s, { type: "result", isError: false });
    return true;
  }
  if (!s?.query) return false;
  // A parked question belongs to the turn being interrupted — release it, or the
  // SDK stays blocked on a promise nobody will ever resolve.
  rejectPendingQuestions(s, "The turn was interrupted before the question could be answered.");
  try {
    await s.query.interrupt();
  } catch (err) {
    console.warn(`[butler-sdk] interrupt failed: project=${projectId} butler=${butlerId} ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  s.busy = false;
  broadcast(s, { type: "result", isError: false });
  return true;
}

/** Conversation history for the active session (empty if none) — replayed by the UI on reload. */
export function getButlerTranscript(projectId: string, butlerId: string = "default"): ButlerTurn[] {
  return sessions.get(butlerSessionKey(projectId, butlerId))?.transcript ?? [];
}

export function subscribeButler(
  projectId: string,
  listener: Listener,
  butlerId: string = "default",
  /** True only for a stream backed by a human UI — see {@link interactiveListenersByKey}. */
  opts?: { interactive?: boolean },
): () => void {
  const key = butlerSessionKey(projectId, butlerId);
  let ls = listenersByKey.get(key);
  if (!ls) {
    ls = new Set();
    listenersByKey.set(key, ls);
  }
  ls.add(listener);
  if (opts?.interactive) {
    let interactive = interactiveListenersByKey.get(key);
    if (!interactive) {
      interactive = new Set();
      interactiveListenersByKey.set(key, interactive);
    }
    interactive.add(listener);
  }
  // Replay current state so a freshly-connected stream is immediately in sync.
  const s = sessions.get(key);
  if (s) {
    if (s.sessionId) listener({ type: "session", sessionId: s.sessionId });
    if (s.model || s.contextWindow || s.mcpConnected !== undefined) listener({ type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
    if (s.contextTokens) listener({ type: "usage", contextTokens: s.contextTokens });
  }
  return () => {
    const interactive = interactiveListenersByKey.get(key);
    if (interactive) {
      interactive.delete(listener);
      if (interactive.size === 0) interactiveListenersByKey.delete(key);
    }
    const set = listenersByKey.get(key);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) listenersByKey.delete(key);
  };
}

export function ensureButlerSession(opts: {
  projectId: string;
  /** Butler definition id; "default" (the legacy butler) when omitted. */
  butlerId?: string;
  repoPath: string;
  projectName: string;
  claudeProfile?: string;
  backend?: "claude" | "codex" | "mock";
  profile?: { provider: ProviderName; name: string };
  agentCommand?: string;
  agentArgs?: string;
  /** CODEX_HOME for a codex OAuth-license butler (caller drops `--profile` to "default"). */
  codexHome?: string;
  resumeSessionId?: string;
  /** Model alias/id for the session (e.g. "opus", "sonnet"). Empty/omitted = profile/CLI default. */
  model?: string;
  /** System-prompt text appended to the claude_code preset. When omitted, a built-in
   *  default is used. Callers (butler route) resolve this from the editable `butler`
   *  agent skill so users can customize the butler's behavior. */
  systemPromptAppend?: string;
}): ButlerSession {
  const butlerId = opts.butlerId || "default";
  const key = butlerSessionKey(opts.projectId, butlerId);
  const existing = sessions.get(key);
  if (existing) return existing;

  const backend = opts.backend ?? "claude";
  const systemPromptAppend = opts.systemPromptAppend ?? buildButlerSystemPrompt(opts.projectName, opts.repoPath);
  const input = backend === "claude" ? new Pushable<SDKUserMessage>() : undefined;
  const session: ButlerSession = {
    projectId: opts.projectId,
    butlerId,
    key,
    backend,
    input,
    abort: new AbortController(),
    busy: false,
    contextTokens: 0,
    transcript: [],
    claudeProfile: opts.claudeProfile,
    model: opts.model || undefined,
    repoPath: opts.repoPath,
    systemPromptAppend,
    profile: opts.profile,
    agentCommand: opts.agentCommand,
    agentArgs: opts.agentArgs,
    codexHome: opts.codexHome,
    pendingQuestions: new Map(),
  };
  sessions.set(key, session);

  if (backend === "codex") {
    session.sessionId = opts.resumeSessionId;
    session.mcpConnected = undefined;
    console.log(`[butler-provider] starting logical session: project=${opts.projectId} butler=${butlerId} backend=codex cwd=${opts.repoPath} resume=${opts.resumeSessionId ?? "none"}`);
    queueMicrotask(() => {
      broadcast(session, { type: "ready" });
      if (session.sessionId) broadcast(session, { type: "session", sessionId: session.sessionId });
      broadcast(session, { type: "meta", model: session.model, contextWindow: session.contextWindow, mcpConnected: session.mcpConnected });
    });
    return session;
  }

  if (backend === "mock") {
    session.sessionId = opts.resumeSessionId || `mock-${Date.now()}`;
    session.mcpConnected = false;
    session.model = "mock";
    session.contextWindow = 200000;
    console.log(`[butler-sdk] starting mock session: project=${opts.projectId} butler=${butlerId}`);
    queueMicrotask(() => {
      broadcast(session, { type: "ready" });
      broadcast(session, { type: "session", sessionId: session.sessionId! });
      broadcast(session, { type: "meta", model: "mock", contextWindow: 200000, mcpConnected: false });
    });
    return session;
  }

  const env = buildSpawnEnv(opts.claudeProfile);
  const options: Options = {
    cwd: opts.repoPath,
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: env,
    abortController: session.abort,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
    // Without this the SDK auto-denies AskUserQuestion with the opaque permission
    // title "Answer questions?" (#459). The handler routes it to the chat UI.
    canUseTool: butlerCanUseTool(session),
    mcpServers: getMcpServersConfig(),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
  };

  console.log(`[butler-sdk] starting warm session: project=${opts.projectId} butler=${butlerId} cwd=${opts.repoPath} resume=${opts.resumeSessionId ?? "none"}`);
  void runLoop(session, input as Pushable<SDKUserMessage>, options);
  return session;
}

function buildProviderTurnPrompt(session: ButlerSession, content: string): string {
  return [
    "System instructions for the project Butler:",
    session.systemPromptAppend,
    "",
    "User message:",
    content,
  ].join("\n");
}

function runProviderTurn(session: ButlerSession, content: string, isRetry = false): void {
  const provider = getProvider("codex");
  const prompt = buildProviderTurnPrompt(session, content);
  // The thread id we are about to resume (if any) — used to recover when its
  // rollout is gone (see isStaleCodexResumeError).
  const resumedSessionId = session.sessionId;
  const config = provider.buildLaunchConfig({
    provider: "codex" satisfies ProviderId,
    providerSessionId: session.sessionId,
    agentCommand: session.agentCommand,
    agentArgs: session.agentArgs,
    profile: session.profile,
    model: session.model,
    prompt,
  });
  const stdinPrompt = config.promptPrefix ? `${config.promptPrefix}\n\n${prompt}` : prompt;
  const proc = spawn(config.command, config.args, {
    cwd: session.repoPath,
    shell: config.useShell,
    windowsHide: true,
    // CODEX_HOME points a license butler at its own auth.json + rollouts. Applied last
    // so it overrides any inherited CODEX_HOME from the parent process env.
    env: {
      ...config.env,
      ...(session.codexHome ? { CODEX_HOME: session.codexHome } : {}),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  session.process = proc;
  session.interrupted = false;

  let assistantText = "";
  let finished = false;
  const finish = (isError: boolean, text?: string) => {
    if (finished) return;
    finished = true;
    session.busy = false;
    session.process = undefined;
    if (!isError && (text ?? assistantText)) {
      session.transcript.push({ role: "assistant", text: text ?? assistantText, ts: Date.now() });
    }
    broadcast(session, { type: "result", text: text ?? assistantText, isError });
  };

  let buffer = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      // Observed parser (#898): a valid-JSON line of an UNKNOWN event type is
      // recorded as an unknown-event metric instead of silently swallowed. This
      // is the same drift/telemetry guard the main agent launch uses via
      // session-manager broadcast; the butler Codex path must not re-open the
      // silent-swallow hole (arch-review §2.4, ticket #14).
      const evt = provider.parseStreamEventObserved(line);
      if (!evt) continue;
      if (evt.providerSessionId) {
        session.sessionId = evt.providerSessionId;
        broadcast(session, { type: "session", sessionId: evt.providerSessionId });
      }
      if (evt.assistantText) {
        assistantText += evt.assistantText;
        broadcast(session, { type: "text", text: evt.assistantText });
      }
      if (evt.toolActivity) {
        broadcast(session, { type: "tool", name: evt.toolActivity.name, toolId: evt.toolActivity.toolUseId, input: evt.toolActivity.input });
      }
      if (evt.toolResult) {
        broadcast(session, { type: "tool-result", toolId: evt.toolResult.toolUseId, output: evt.toolResult.agentResultText });
      }
      if (evt.liveStats?.contextTokens) {
        session.contextTokens = evt.liveStats.contextTokens;
        broadcast(session, { type: "usage", contextTokens: session.contextTokens });
      }
      if (evt.liveStats?.model) {
        session.model = evt.liveStats.model;
        broadcast(session, { type: "meta", model: session.model, contextWindow: session.contextWindow, mcpConnected: session.mcpConnected });
      }
      if (evt.turnComplete) finish(false);
    }
  });

  let stderrText = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      stderrText += `${text}\n`;
      console.warn(`[butler-provider] codex stderr: ${text}`);
    }
  });

  proc.on("error", (err) => {
    broadcast(session, { type: "error", message: err.message });
    finish(true, err.message);
  });
  proc.on("exit", (code) => {
    if (session.interrupted) {
      session.interrupted = false;
      return;
    }
    if (buffer.trim()) {
      // Drain-on-exit: parse the trailing partial line through the observed
      // parser too, so a final unknown-event line is recorded rather than
      // silently dropped (#898 / arch-review §2.4).
      const evt = provider.parseStreamEventObserved(buffer.trim());
      if (evt?.assistantText) {
        assistantText += evt.assistantText;
        broadcast(session, { type: "text", text: evt.assistantText });
      }
    }
    // The resumed thread's rollout is gone (pruned / different CODEX_HOME). Drop the
    // dead resume id and retry the SAME turn on a fresh thread, exactly like the Claude
    // butler's stale-resume recovery. Without this the persisted id bricks every turn.
    // Only the resume attempt failed — the user's message must not be silently dropped.
    if (code !== 0 && !isRetry && resumedSessionId && isStaleCodexResumeError(stderrText)) {
      console.warn(`[butler-provider] codex resume ${resumedSessionId} stale (no rollout), starting fresh: project=${session.projectId} butler=${session.butlerId}`);
      session.sessionId = undefined;
      // A fresh `codex exec` (no resume) emits a new thread.started, whose id is
      // broadcast as a {type:"session"} event → the route overwrites the persisted
      // (now-dead) resume pref with the new good id.
      runProviderTurn(session, content, true);
      return;
    }
    finish(code !== 0, code === 0 ? undefined : `Codex Butler exited with code ${code ?? "unknown"}`);
  });

  if (config.suppressStdinPrompt) proc.stdin?.end();
  else proc.stdin?.end(stdinPrompt + "\n");
}

/** Pull the available slash commands from the live session (best-effort). */
async function fetchSessionCapabilities(session: ButlerSession, q: Query): Promise<void> {
  try {
    const commands: SlashCommand[] = await q.supportedCommands();
    session.commands = commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  } catch (err) {
    console.warn(`[butler-sdk] supportedCommands failed: project=${session.projectId} ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Broadcast the *true* context-window occupancy via the SDK's own accounting
 * (`getContextUsage().totalTokens` / `maxTokens`) — the same number Claude Code's
 * /context shows. This is NOT the same as summing a turn's usage token counts:
 * `cache_read_input_tokens` accumulates across every tool round-trip in a turn, so
 * that sum balloons far past the real context size (e.g. 400k for a 30k context).
 */
async function broadcastContextUsage(session: ButlerSession, q: Query): Promise<void> {
  try {
    const usage = await (q as unknown as {
      getContextUsage: () => Promise<{ totalTokens?: number; maxTokens?: number; rawMaxTokens?: number }>;
    }).getContextUsage();
    const total = usage.totalTokens ?? 0;
    const max = usage.maxTokens ?? usage.rawMaxTokens;
    if (total > 0) {
      session.contextTokens = total;
      broadcast(session, { type: "usage", contextTokens: total });
    }
    if (max && max !== session.contextWindow) {
      session.contextWindow = max;
      broadcast(session, { type: "meta", model: session.model, contextWindow: max, mcpConnected: session.mcpConnected });
    }
  } catch (err) {
    console.warn(`[butler-sdk] getContextUsage failed: project=${session.projectId} ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Check if an error message indicates a stale/missing Claude Code session that
 * cannot be resumed. The SDK surfaces this as:
 *   "No conversation found with session ID: <uuid>"
 * When this happens during a `resume` attempt, we can recover by starting fresh.
 */
function isStaleResumeError(message: string): boolean {
  return /no conversation found/i.test(message);
}

/**
 * Codex analogue of {@link isStaleResumeError}. When a codex butler resumes a
 * thread whose on-disk rollout is gone (pruned, or created under a different
 * CODEX_HOME/license), `codex exec ... resume <id>` writes to STDERR and exits
 * non-zero with no stdout events:
 *   "Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)"
 * The persisted thread id then bricks the butler — every turn re-resumes the same
 * dead id and exits 1. Detecting this lets us drop the resume and retry fresh.
 */
export function isStaleCodexResumeError(message: string): boolean {
  return /no rollout found for thread|thread\/resume failed/i.test(message);
}

/**
 * Check if an error indicates a resumed transcript whose thinking block can't be
 * verified. The API surfaces this as a 400:
 *   "messages.N.content.0: Invalid signature in thinking block"
 * Thinking-block signatures are bound to the org/endpoint that produced them, so a
 * session resumed under a different Claude profile (e.g. the global `claude_profile`
 * flipped to `mock` and back, or a profile change that didn't clear the resume id)
 * makes the persisted transcript permanently un-sendable. Like a stale resume id, the
 * only recovery is to drop the resume and start a fresh conversation.
 */
export function isInvalidThinkingSignatureError(message: string): boolean {
  return /invalid signature in thinking block/i.test(message);
}

/**
 * Flatten a tool_result `content` field into display text. The SDK hands it back as
 * a plain string or an array of content blocks ({type:"text",text} / images). We keep
 * the text, note images, and cap the length so a huge file read can't flood the stream.
 */
function stringifyToolResult(content: unknown): string | undefined {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        if (block?.type === "text" && typeof block.text === "string") return block.text;
        if (block?.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    return undefined;
  }
  const MAX = 4000;
  return text.length > MAX ? `${text.slice(0, MAX)}\n… (${text.length - MAX} more chars)` : text;
}

// ── runLoop message dispatch ──────────────────────────────────────────────────
// One handler per SDK message type. Each mutates session state and/or broadcasts
// events exactly as the inline branch did; kept as small functions so runLoop is a
// flat dispatch instead of a CC-38 if/else wall.

function handleButlerInit(session: ButlerSession, msg: Record<string, unknown>): void {
  const init = msg as { session_id?: string; model?: string; mcp_servers?: { name: string; status: string }[] };
  if (init.session_id) {
    session.sessionId = init.session_id;
    broadcast(session, { type: "session", sessionId: init.session_id });
  }
  if (init.model) session.model = init.model;
  const kanbanMcp = init.mcp_servers?.find((s) => s.name === "agentic-kanban");
  if (kanbanMcp) session.mcpConnected = kanbanMcp.status === "connected";
  broadcast(session, { type: "meta", model: session.model, contextWindow: session.contextWindow, mcpConnected: session.mcpConnected });
}

function handleButlerStreamEvent(session: ButlerSession, msg: Record<string, unknown>): void {
  const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
  if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
    broadcast(session, { type: "text", text: ev.delta.text });
  }
}

function handleButlerAssistant(session: ButlerSession, msg: Record<string, unknown>): void {
  const content = (msg as { message?: { content?: Array<{ type?: string; name?: string; id?: string; input?: Record<string, unknown> }> } }).message?.content ?? [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      broadcast(session, { type: "tool", name: block.name, toolId: block.id, input: block.input });
    }
  }
}

function handleButlerToolResults(session: ButlerSession, msg: Record<string, unknown>): void {
  // Tool results arrive as a synthetic user message whose content holds
  // tool_result blocks. Surface each so the UI can pair it with its tool call.
  const content = (msg as { message?: { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> } }).message?.content ?? [];
  for (const block of content) {
    if (block.type === "tool_result") {
      broadcast(session, { type: "tool-result", toolId: block.tool_use_id, output: stringifyToolResult(block.content), isError: block.is_error });
    }
  }
}

function handleButlerResult(session: ButlerSession, msg: Record<string, unknown>, q: Query): void {
  session.busy = false;
  const subtype = (msg as { subtype?: string }).subtype;
  const result = (msg as { result?: string }).result;
  if (subtype === "success" && result) {
    session.transcript.push({ role: "assistant", text: result, ts: Date.now() });
  }
  broadcast(session, { type: "result", text: subtype === "success" ? result : undefined, isError: subtype !== "success" });
  // Report the true context-window occupancy (not the cache-inflated turn usage sum).
  void broadcastContextUsage(session, q);
}

function dispatchButlerMessage(session: ButlerSession, msg: Record<string, unknown>, q: Query): void {
  const type = msg.type as string;
  if (type === "system" && (msg as { subtype?: string }).subtype === "init") handleButlerInit(session, msg);
  else if (type === "stream_event") handleButlerStreamEvent(session, msg);
  else if (type === "assistant") handleButlerAssistant(session, msg);
  else if (type === "user") handleButlerToolResults(session, msg);
  else if (type === "result") handleButlerResult(session, msg, q);
}

/**
 * Recover from a thrown SDK loop error whose outcome is `resume-reset`: drop the
 * dead resume id, restart the loop fresh, and re-send any in-flight turn (the
 * fresh session has no prior thinking blocks, so it can't re-hit the signature
 * error that surfaced the failure). Returns true if it restarted the loop.
 */
function recoverButlerResume(session: ButlerSession, input: Pushable<SDKUserMessage>, options: Options, message: string): boolean {
  const reason = isStaleResumeError(message) ? "not found" : "had an invalid thinking-block signature";
  console.warn(`[butler-sdk] resume session ${String((options as Record<string, unknown>).resume)} ${reason}, starting fresh: project=${session.projectId}`);
  delete (options as Record<string, unknown>).resume;
  session.sessionId = undefined;
  const pendingTurn = session.busy
    ? [...session.transcript].reverse().find((t) => t.role === "user")?.text
    : undefined;
  void runLoop(session, input, options);
  if (pendingTurn) {
    input.push({ type: "user", message: { role: "user", content: pendingTurn }, parent_tool_use_id: null });
  }
  return true;
}

async function runLoop(session: ButlerSession, input: Pushable<SDKUserMessage>, options: Options): Promise<void> {
  let retrying = false;
  try {
    const q = query({ prompt: input, options });
    session.query = q;
    broadcast(session, { type: "ready" });
    // Fetch the live slash-command list + baseline context usage once (control requests).
    void fetchSessionCapabilities(session, q);
    void broadcastContextUsage(session, q);
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      dispatchButlerMessage(session, msg, q);
    }
    console.log(`[butler-sdk] session loop ended: project=${session.projectId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = classifyButlerLoopError({
      aborted: session.abort.signal.aborted,
      transient: isTransientNetworkError(err),
      hasResume: Boolean((options as Record<string, unknown>).resume),
      staleResume: isStaleResumeError(message),
      invalidThinkingSignature: isInvalidThinkingSignatureError(message),
    });
    switch (outcome) {
      case "aborted":
        // Deliberate teardown (clear-context, profile switch, server stop) aborts the
        // SDK query, surfacing as an "operation aborted" throw. Expected — do NOT
        // broadcast it as an error, or a stream reconnecting right after the stop (the
        // clear-context flow reopens immediately) would render a spurious error.
        console.log(`[butler-sdk] session aborted (intentional): project=${session.projectId}`);
        break;
      case "transient":
        // Anthropic HTTPS socket got killed (tsx hot-reload, network blip, manual stop).
        // Don't propagate — the dev loop keeps running and the next ensureButlerSession()
        // reopens a warm connection.
        console.warn(`[butler-sdk] transient network error (ignored): project=${session.projectId} ${message}`);
        break;
      case "resume-reset":
        // The persisted session can't be resumed (gone, or unverifiable thinking-block
        // signature). Drop the resume id and start fresh — no user-facing error.
        retrying = recoverButlerResume(session, input, options, message);
        break;
      case "fatal":
        console.error(`[butler-sdk] session error: project=${session.projectId} ${message}`);
        broadcast(session, { type: "error", message });
        break;
    }
  } finally {
    if (!retrying) {
      rejectPendingQuestions(session, "The butler session ended before the question could be answered.");
      session.query = undefined;
      sessions.delete(session.key);
    }
  }
}

export function sendButlerTurn(
  projectId: string,
  content: string,
  opts?: { emitUserText?: boolean; butlerId?: string },
): boolean {
  const s = sessions.get(butlerSessionKey(projectId, opts?.butlerId));
  if (!s) return false;
  if (s.busy) return false;
  s.busy = true;
  s.transcript.push({ role: "user", text: content, ts: Date.now() });
  // For turns the UI itself didn't type (CLI/MCP `ask`), broadcast the prompt so
  // connected chat views render it instead of showing the butler acting on an
  // invisible request. The UI's own /message path renders its prompt optimistically,
  // so it leaves this off to avoid a duplicate bubble.
  if (opts?.emitUserText) broadcast(s, { type: "user", text: content });
  broadcast(s, { type: "turn-start" });
  if (s.backend === "codex") {
    runProviderTurn(s, content);
  } else if (s.backend === "mock") {
    const turnContent = content;
    setTimeout(() => {
      const response = `[mock] ${turnContent}`;
      broadcast(s, { type: "text", text: response });
      s.transcript.push({ role: "assistant", text: response, ts: Date.now() });
      s.busy = false;
      broadcast(s, { type: "result", text: response, isError: false });
    }, 50);
  } else {
    s.input?.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }
  return true;
}

export function stopButlerSession(projectId: string, butlerId: string = "default"): void {
  const key = butlerSessionKey(projectId, butlerId);
  const s = sessions.get(key);
  if (!s) return;
  console.log(`[butler-sdk] stopping session: project=${s.projectId} butler=${s.butlerId}`);
  rejectPendingQuestions(s, "The butler session was stopped before the question could be answered.");
  if (s.process?.pid) s.process.kill();
  s.input?.end();
  s.abort.abort();
  sessions.delete(key);
}
