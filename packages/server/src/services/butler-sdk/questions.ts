/**
 * AskUserQuestion: park it for the human instead of auto-denying (#459/#460/#461).
 *
 * The butler runs the Agent SDK with the `claude_code` system-prompt preset, which
 * advertises `AskUserQuestion`. Without a `canUseTool` handler the SDK auto-denies
 * every such call and hands the model an is_error tool_result whose whole content is
 * the permission-prompt title ("Answer questions?") — an opaque failure the user sees
 * as a red tool card, and which the model then works around by re-asking in prose
 * (#459, measured on butler session 32280042-19e3-4a74-b9e4-59924a25cb5a).
 *
 * The butler is the ONE agent surface with a human at the keyboard, so instead we park
 * the call, broadcast the questions to the chat, and resolve when the user answers.
 */
import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ButlerQuestion, ButlerQuestionAnswer, ButlerQuestionOption, ButlerSession, PendingButlerQuestion } from "./types.js";
import { broadcast, butlerSessionKey, hasInteractiveButlerListener, sessions } from "./registry.js";

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
export function butlerCanUseTool(session: ButlerSession): CanUseTool {
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
export function rejectPendingQuestions(session: ButlerSession, message: string): void {
  for (const pending of [...session.pendingQuestions.values()]) {
    broadcast(session, { type: "question-resolved", askId: pending.askId, reason: "cancelled" });
    pending.settle({ behavior: "deny", message });
  }
  session.pendingQuestions.clear();
}
