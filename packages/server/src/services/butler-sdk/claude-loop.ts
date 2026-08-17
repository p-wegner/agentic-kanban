/**
 * The Claude Agent SDK message loop: dispatches each streamed SDK message type to
 * a small handler, recovers from a stale/unresumable session, and reports the true
 * context-window occupancy via the SDK's own accounting.
 */
import { query, type Options, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { isTransientNetworkError } from "../../lib/transient-errors.js";
import { classifyButlerLoopError } from "../../lib/butler-loop-classify.js";
import type { ButlerSession } from "./types.js";
import type { Pushable } from "./pushable.js";
import { broadcast, sessions } from "./registry.js";
import { rejectPendingQuestions } from "./questions.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** Pull the available slash commands from the live session (best-effort). */
async function fetchSessionCapabilities(session: ButlerSession, q: Query): Promise<void> {
  try {
    const commands: SlashCommand[] = await q.supportedCommands();
    session.commands = commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  } catch (err) {
    console.warn(`[butler-sdk] supportedCommands failed: project=${session.projectId} ${errorMessage(err)}`);
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
    console.warn(`[butler-sdk] getContextUsage failed: project=${session.projectId} ${errorMessage(err)}`);
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

export async function runLoop(session: ButlerSession, input: Pushable<SDKUserMessage>, options: Options): Promise<void> {
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
    const message = errorMessage(err);
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
