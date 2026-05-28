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
import { query, type Options, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { buildSpawnEnv, getMcpServersConfig } from "./agent-provider/helpers.js";
import { ensureBoardGuideFile } from "../butler/board-guide.js";
import { isTransientNetworkError } from "../startup/transient-errors.js";

/** Compact slash-command descriptor surfaced to the UI autocomplete. */
export interface ButlerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "usage"; contextTokens: number }
  | { type: "meta"; model?: string; contextWindow?: number; mcpConnected?: boolean }
  | { type: "error"; message: string };

type Listener = (e: ButlerEvent) => void;

/** A persisted conversation turn, replayed when the chat UI reloads. */
export interface ButlerTurn {
  role: "user" | "assistant";
  text: string;
  ts: number;
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
      this.waiting({ value: undefined as unknown as T, done: true });
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
  input: Pushable<SDKUserMessage>;
  sessionId?: string;
  abort: AbortController;
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
}

const sessions = new Map<string, ButlerSession>();

/**
 * SSE listeners keyed by projectId, kept SEPARATE from the session lifecycle. A
 * stream connects once and must keep receiving events across "clear context" and
 * profile switches, which stop+recreate the underlying session. If listeners lived
 * on the session, reconnecting the stream while no session exists (the gap between
 * stop and the next message) would silently drop the listener and the stream would
 * go dead. Keeping them here means a stream stays attached regardless.
 */
const listenersByProject = new Map<string, Set<Listener>>();

function broadcast(s: ButlerSession, e: ButlerEvent): void {
  const ls = listenersByProject.get(s.projectId);
  if (!ls) return;
  for (const l of ls) {
    try {
      l(e);
    } catch (err) {
      console.error(`[butler-sdk] listener error: project=${s.projectId}`, err);
    }
  }
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
    `The user operates the board in the app's UI (clicking buttons), not the API. For "how do I…/how does X work" board questions, answer with simple UI steps (which tab/button) — a UI how-to is bundled at ${boardGuidePath}; READ it first and answer from it, don't dump API/tool names.`,
    `To start/launch work on an issue, use the board's one-step flow: POST http://localhost:${serverPort}/api/workspaces with { "issueId", "branch": "feature/ak-<n>-<slug>" }. It creates the worktree, moves the issue to In Progress, and launches the agent. Do NOT use start_workspace (it does not launch an agent), and never create worktrees/branches or run claude yourself.`,
    `Never claim an action succeeded (launched, moved, merged) unless the board confirms it — re-check with get_issue/get_board_status and report the real result; if unsure, say so.`,
    `Be concise and helpful; avoid unnecessary preamble. You have full read access to the project files and standard tools.`,
  ].join("\n");
}

export function getButlerSession(projectId: string): { sessionId?: string; active: boolean; contextTokens: number; model?: string; contextWindow?: number; mcpConnected?: boolean; claudeProfile?: string } {
  const s = sessions.get(projectId);
  return { sessionId: s?.sessionId, active: !!s, contextTokens: s?.contextTokens ?? 0, model: s?.model, contextWindow: s?.contextWindow, mcpConnected: s?.mcpConnected, claudeProfile: s?.claudeProfile };
}

/** Slash commands the active session reported as available (empty if none/not yet fetched). */
export function getButlerCommands(projectId: string): ButlerCommand[] {
  return sessions.get(projectId)?.commands ?? [];
}

/**
 * Switch the model for subsequent turns WITHOUT restarting — uses the SDK's
 * `query.setModel()` control request, so conversation context is preserved.
 * Returns false if there is no active session. An empty string clears the
 * override (back to the profile/CLI default).
 */
export async function setButlerModel(projectId: string, model: string): Promise<boolean> {
  const s = sessions.get(projectId);
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
export async function interruptButler(projectId: string): Promise<boolean> {
  const s = sessions.get(projectId);
  if (!s?.query) return false;
  try {
    await s.query.interrupt();
  } catch (err) {
    console.warn(`[butler-sdk] interrupt failed: project=${projectId} ${err instanceof Error ? err.message : err}`);
    return false;
  }
  s.busy = false;
  broadcast(s, { type: "result", isError: false });
  return true;
}

/** Conversation history for the active session (empty if none) — replayed by the UI on reload. */
export function getButlerTranscript(projectId: string): ButlerTurn[] {
  return sessions.get(projectId)?.transcript ?? [];
}

export function subscribeButler(projectId: string, listener: Listener): () => void {
  let ls = listenersByProject.get(projectId);
  if (!ls) {
    ls = new Set();
    listenersByProject.set(projectId, ls);
  }
  ls.add(listener);
  // Replay current state so a freshly-connected stream is immediately in sync.
  const s = sessions.get(projectId);
  if (s) {
    if (s.sessionId) listener({ type: "session", sessionId: s.sessionId });
    if (s.model || s.contextWindow || s.mcpConnected !== undefined) listener({ type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
    if (s.contextTokens) listener({ type: "usage", contextTokens: s.contextTokens });
  }
  return () => {
    const set = listenersByProject.get(projectId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) listenersByProject.delete(projectId);
  };
}

export function ensureButlerSession(opts: {
  projectId: string;
  repoPath: string;
  projectName: string;
  claudeProfile?: string;
  resumeSessionId?: string;
  /** Model alias/id for the session (e.g. "opus", "sonnet"). Empty/omitted = profile/CLI default. */
  model?: string;
  /** System-prompt text appended to the claude_code preset. When omitted, a built-in
   *  default is used. Callers (butler route) resolve this from the editable `butler`
   *  agent skill so users can customize the butler's behavior. */
  systemPromptAppend?: string;
}): ButlerSession {
  const existing = sessions.get(opts.projectId);
  if (existing) return existing;

  const input = new Pushable<SDKUserMessage>();
  const session: ButlerSession = {
    projectId: opts.projectId,
    input,
    abort: new AbortController(),
    busy: false,
    contextTokens: 0,
    transcript: [],
    claudeProfile: opts.claudeProfile,
    model: opts.model || undefined,
  };
  sessions.set(opts.projectId, session);

  const env = buildSpawnEnv(opts.claudeProfile);
  const options: Options = {
    cwd: opts.repoPath,
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: env as Options["env"],
    abortController: session.abort,
    systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPromptAppend ?? buildButlerSystemPrompt(opts.projectName, opts.repoPath) },
    mcpServers: getMcpServersConfig(),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
  };

  console.log(`[butler-sdk] starting warm session: project=${opts.projectId} cwd=${opts.repoPath} resume=${opts.resumeSessionId ?? "none"}`);
  void runLoop(session, input, options);
  return session;
}

/** Pull the available slash commands from the live session (best-effort). */
async function fetchSessionCapabilities(session: ButlerSession, q: Query): Promise<void> {
  try {
    const commands: SlashCommand[] = await q.supportedCommands();
    session.commands = commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
  } catch (err) {
    console.warn(`[butler-sdk] supportedCommands failed: project=${session.projectId} ${err instanceof Error ? err.message : err}`);
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
    console.warn(`[butler-sdk] getContextUsage failed: project=${session.projectId} ${err instanceof Error ? err.message : err}`);
  }
}

async function runLoop(session: ButlerSession, input: Pushable<SDKUserMessage>, options: Options): Promise<void> {
  try {
    const q = query({ prompt: input, options });
    session.query = q;
    broadcast(session, { type: "ready" });
    // Fetch the live slash-command list + baseline context usage once (control requests).
    void fetchSessionCapabilities(session, q);
    void broadcastContextUsage(session, q);
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      const type = msg.type as string;
      if (type === "system" && (msg as { subtype?: string }).subtype === "init") {
        const init = msg as { session_id?: string; model?: string; mcp_servers?: { name: string; status: string }[] };
        if (init.session_id) {
          session.sessionId = init.session_id;
          broadcast(session, { type: "session", sessionId: init.session_id });
        }
        if (init.model) session.model = init.model;
        const kanbanMcp = init.mcp_servers?.find((s) => s.name === "agentic-kanban");
        if (kanbanMcp) session.mcpConnected = kanbanMcp.status === "connected";
        broadcast(session, { type: "meta", model: session.model, contextWindow: session.contextWindow, mcpConnected: session.mcpConnected });
      } else if (type === "stream_event") {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          broadcast(session, { type: "text", text: ev.delta.text });
        }
      } else if (type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type?: string; name?: string }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use" && block.name) broadcast(session, { type: "tool", name: block.name });
        }
      } else if (type === "result") {
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
    }
    console.log(`[butler-sdk] session loop ended: project=${session.projectId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientNetworkError(err)) {
      // Anthropic HTTPS socket got killed (tsx hot-reload, network blip, manual stop).
      // Don't propagate or surface as a hard error — the dev loop must keep running and
      // the next ensureButlerSession() call will reopen a warm connection.
      console.warn(`[butler-sdk] transient network error (ignored): project=${session.projectId} ${message}`);
    } else {
      console.error(`[butler-sdk] session error: project=${session.projectId} ${message}`);
      broadcast(session, { type: "error", message });
    }
  } finally {
    session.query = undefined;
    sessions.delete(session.projectId);
  }
}

export function sendButlerTurn(projectId: string, content: string): boolean {
  const s = sessions.get(projectId);
  if (!s) return false;
  s.busy = true;
  s.transcript.push({ role: "user", text: content, ts: Date.now() });
  broadcast(s, { type: "turn-start" });
  s.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  return true;
}

export function stopButlerSession(projectId: string): void {
  const s = sessions.get(projectId);
  if (!s) return;
  console.log(`[butler-sdk] stopping session: project=${s.projectId}`);
  s.input.end();
  s.abort.abort();
  sessions.delete(projectId);
}
