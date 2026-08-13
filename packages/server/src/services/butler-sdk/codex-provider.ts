/**
 * Codex-backed butler turn: spawns `codex exec` per turn (no warm SDK session for
 * this backend — see `packages/server/CLAUDE.md` "Pi task agents" for the analogous
 * CLI-subprocess model), parses its observed stream, and recovers from a stale
 * resume by dropping the dead thread id and retrying fresh.
 */
import { spawn } from "node:child_process";
import { getProvider, type ProviderId } from "../agent-provider.js";
import type { ButlerSession } from "./types.js";
import { broadcast } from "./registry.js";

function buildProviderTurnPrompt(session: ButlerSession, content: string): string {
  return [
    "System instructions for the project Butler:",
    session.systemPromptAppend,
    "",
    "User message:",
    content,
  ].join("\n");
}

export function runProviderTurn(session: ButlerSession, content: string, isRetry = false): void {
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

/**
 * Codex analogue of `isStaleResumeError` (claude-loop.ts). When a codex butler
 * resumes a thread whose on-disk rollout is gone (pruned, or created under a
 * different CODEX_HOME/license), `codex exec ... resume <id>` writes to STDERR
 * and exits non-zero with no stdout events:
 *   "Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)"
 * The persisted thread id then bricks the butler — every turn re-resumes the same
 * dead id and exits 1. Detecting this lets us drop the resume and retry fresh.
 */
export function isStaleCodexResumeError(message: string): boolean {
  return /no rollout found for thread|thread\/resume failed/i.test(message);
}
