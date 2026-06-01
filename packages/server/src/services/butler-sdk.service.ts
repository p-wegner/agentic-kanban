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
import { spawn, type ChildProcess } from "node:child_process";
import { query, type Options, type Query, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { buildSpawnEnv, getMcpServersConfig } from "./agent-provider/helpers.js";
import { ensureBoardGuideFile } from "../butler/board-guide.js";
import { isTransientNetworkError } from "../startup/transient-errors.js";
import { getProvider, type ProviderId, type ProviderName } from "./agent-provider.js";

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
  | { type: "user"; text: string }
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
  /** Which butler (definition id) this session belongs to. "default" is the
   *  legacy/always-present butler; others are user-defined named butlers. */
  butlerId: string;
  /** Composite map key: plain projectId for the default butler (backward compat),
   *  `${projectId}::${butlerId}` for any other. */
  key: string;
  backend: "claude" | "codex";
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

function buildButlerSystemPrompt(projectName: string, repoPath: string): string {
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  const boardGuidePath = ensureBoardGuideFile();
  return [
    `You are the project butler for "${projectName}" — a persistent, warm assistant embedded in the agentic-kanban board.`,
    `Project location: ${repoPath}`,
    `Board API: http://localhost:${serverPort}/api`,
    `Answer questions about the project, codebase, and active work. Help with quick analysis, research, and code questions. Orchestrate work through the board and ensure the kanban workflow is followed.`,
    `For anything about the board (issues, statuses, counts, workspaces, sessions), use the "agentic-kanban" MCP tools (e.g. list_issues, get_board_status, get_issue) — they are authoritative. Do NOT guess board state or scrape it via curl.`,
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
  backend: "claude" | "codex";
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
  try {
    await s.query.interrupt();
  } catch (err) {
    console.warn(`[butler-sdk] interrupt failed: project=${projectId} butler=${butlerId} ${err instanceof Error ? err.message : err}`);
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

export function subscribeButler(projectId: string, listener: Listener, butlerId: string = "default"): () => void {
  const key = butlerSessionKey(projectId, butlerId);
  let ls = listenersByKey.get(key);
  if (!ls) {
    ls = new Set();
    listenersByKey.set(key, ls);
  }
  ls.add(listener);
  // Replay current state so a freshly-connected stream is immediately in sync.
  const s = sessions.get(key);
  if (s) {
    if (s.sessionId) listener({ type: "session", sessionId: s.sessionId });
    if (s.model || s.contextWindow || s.mcpConnected !== undefined) listener({ type: "meta", model: s.model, contextWindow: s.contextWindow, mcpConnected: s.mcpConnected });
    if (s.contextTokens) listener({ type: "usage", contextTokens: s.contextTokens });
  }
  return () => {
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
  backend?: "claude" | "codex";
  profile?: { provider: ProviderName; name: string };
  agentCommand?: string;
  agentArgs?: string;
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

  const env = buildSpawnEnv(opts.claudeProfile);
  const options: Options = {
    cwd: opts.repoPath,
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: env as Options["env"],
    abortController: session.abort,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend },
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

function runProviderTurn(session: ButlerSession, content: string): void {
  const provider = getProvider("codex");
  const prompt = buildProviderTurnPrompt(session, content);
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
    env: { ...config.env, FORCE_COLOR: "0", NO_COLOR: "1" },
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
      const evt = provider.parseStreamEvent(line);
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
        broadcast(session, { type: "tool", name: evt.toolActivity.name });
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

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.warn(`[butler-provider] codex stderr: ${text}`);
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
      const evt = provider.parseStreamEvent(buffer.trim());
      if (evt?.assistantText) {
        assistantText += evt.assistantText;
        broadcast(session, { type: "text", text: evt.assistantText });
      }
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

/**
 * Check if an error message indicates a stale/missing Claude Code session that
 * cannot be resumed. The SDK surfaces this as:
 *   "No conversation found with session ID: <uuid>"
 * When this happens during a `resume` attempt, we can recover by starting fresh.
 */
function isStaleResumeError(message: string): boolean {
  return /no conversation found/i.test(message);
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
    if (session.abort.signal.aborted) {
      // Deliberate teardown (clear-context, profile switch, server stop) aborts the
      // SDK query, surfacing as an "operation aborted" throw. This is expected — do
      // NOT broadcast it as an error, or a stream reconnecting right after the stop
      // (the clear-context flow reopens immediately) would render a spurious error.
      console.log(`[butler-sdk] session aborted (intentional): project=${session.projectId}`);
    } else if (isTransientNetworkError(err)) {
      // Anthropic HTTPS socket got killed (tsx hot-reload, network blip, manual stop).
      // Don't propagate or surface as a hard error — the dev loop must keep running and
      // the next ensureButlerSession() call will reopen a warm connection.
      console.warn(`[butler-sdk] transient network error (ignored): project=${session.projectId} ${message}`);
    } else if ((options as Record<string, unknown>).resume && isStaleResumeError(message)) {
      // The persisted session no longer exists (server restart, cache eviction, etc.).
      // Drop the stale resume id and start a fresh conversation — no user-facing error.
      console.warn(`[butler-sdk] resume session ${(options as Record<string, unknown>).resume} not found, starting fresh: project=${session.projectId}`);
      delete (options as Record<string, unknown>).resume;
      session.sessionId = undefined;
      retrying = true;
      void runLoop(session, input, options);
    } else {
      console.error(`[butler-sdk] session error: project=${session.projectId} ${message}`);
      broadcast(session, { type: "error", message });
    }
  } finally {
    if (!retrying) {
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
  if (s.process?.pid) s.process.kill();
  s.input?.end();
  s.abort.abort();
  sessions.delete(key);
}
