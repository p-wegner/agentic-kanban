/**
 * Butler session lifecycle: create/resume a warm session (claude/codex/mock
 * backends), switch its model, interrupt an in-flight turn, or tear it down.
 */
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildSpawnEnv, getMcpServersConfig } from "../agent-provider/helpers.js";
import type { ProviderName } from "../agent-provider.js";
import type { ButlerSession } from "./types.js";
import { Pushable } from "./pushable.js";
import { broadcast, butlerSessionKey, sessions } from "./registry.js";
import { butlerCanUseTool, rejectPendingQuestions } from "./questions.js";
import { buildButlerSystemPrompt } from "./system-prompt.js";
import { runLoop } from "./claude-loop.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
    console.warn(`[butler-sdk] interrupt failed: project=${projectId} butler=${butlerId} ${errorMessage(err)}`);
    return false;
  }
  s.busy = false;
  broadcast(s, { type: "result", isError: false });
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
