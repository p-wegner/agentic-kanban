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
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildSpawnEnv } from "./agent-provider/helpers.js";

export type ButlerEvent =
  | { type: "ready" }
  | { type: "session"; sessionId: string }
  | { type: "turn-start" }
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "result"; text?: string; isError?: boolean }
  | { type: "error"; message: string };

type Listener = (e: ButlerEvent) => void;

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
  listeners: Set<Listener>;
  sessionId?: string;
  abort: AbortController;
  busy: boolean;
}

const sessions = new Map<string, ButlerSession>();

function broadcast(s: ButlerSession, e: ButlerEvent): void {
  for (const l of s.listeners) {
    try {
      l(e);
    } catch (err) {
      console.error(`[butler-sdk] listener error: project=${s.projectId}`, err);
    }
  }
}

function buildButlerSystemPrompt(projectName: string, repoPath: string): string {
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  return [
    `You are the project butler for "${projectName}" — a persistent, warm assistant embedded in the agentic-kanban board.`,
    `Project location: ${repoPath}`,
    `Board API: http://localhost:${serverPort}/api`,
    `Answer questions about the project, codebase, and active work. Help with quick analysis, research, and code questions.`,
    `Be concise and helpful; avoid unnecessary preamble. You have full read access to the project files and standard tools.`,
  ].join("\n");
}

export function getButlerSession(projectId: string): { sessionId?: string; active: boolean } {
  const s = sessions.get(projectId);
  return { sessionId: s?.sessionId, active: !!s };
}

export function subscribeButler(projectId: string, listener: Listener): () => void {
  const s = sessions.get(projectId);
  if (!s) return () => {};
  s.listeners.add(listener);
  if (s.sessionId) listener({ type: "session", sessionId: s.sessionId });
  return () => {
    s.listeners.delete(listener);
  };
}

export function ensureButlerSession(opts: {
  projectId: string;
  repoPath: string;
  projectName: string;
  claudeProfile?: string;
  resumeSessionId?: string;
}): ButlerSession {
  const existing = sessions.get(opts.projectId);
  if (existing) return existing;

  const input = new Pushable<SDKUserMessage>();
  const session: ButlerSession = {
    projectId: opts.projectId,
    input,
    listeners: new Set(),
    abort: new AbortController(),
    busy: false,
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
    systemPrompt: { type: "preset", preset: "claude_code", append: buildButlerSystemPrompt(opts.projectName, opts.repoPath) },
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
  };

  console.log(`[butler-sdk] starting warm session: project=${opts.projectId} cwd=${opts.repoPath} resume=${opts.resumeSessionId ?? "none"}`);
  void runLoop(session, input, options);
  return session;
}

async function runLoop(session: ButlerSession, input: Pushable<SDKUserMessage>, options: Options): Promise<void> {
  try {
    const q = query({ prompt: input, options });
    broadcast(session, { type: "ready" });
    for await (const msg of q as AsyncIterable<Record<string, unknown>>) {
      const type = msg.type as string;
      if (type === "system" && (msg as { subtype?: string }).subtype === "init") {
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) {
          session.sessionId = sid;
          broadcast(session, { type: "session", sessionId: sid });
        }
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
        broadcast(session, { type: "result", text: subtype === "success" ? result : undefined, isError: subtype !== "success" });
      }
    }
    console.log(`[butler-sdk] session loop ended: project=${session.projectId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[butler-sdk] session error: project=${session.projectId} ${message}`);
    broadcast(session, { type: "error", message });
  } finally {
    sessions.delete(session.projectId);
  }
}

export function sendButlerTurn(projectId: string, content: string): boolean {
  const s = sessions.get(projectId);
  if (!s) return false;
  s.busy = true;
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
