/**
 * The train shepherd's REAL runner (#1572): one agent turn through the board's placed one-shot path
 * (a fleet worker edits a checkout of the train tree, or the host does when none is eligible), but
 * with the provider's JSON result so the turn reports what it cost and which session it was.
 *
 * That is what makes `merge_train_agent_fix_cost_cap_usd` bite (the old one-shot reported nothing),
 * and what lets the shepherd RESUME its session on the next turn instead of starting cold.
 * Only Claude prints a JSON result with usage; any other provider runs as plain text and reports
 * no session or usage, exactly like the one-shot runner did (the caps that need usage then stay off).
 */
import type { Database } from "../db/index.js";
import { invokeClaudePrompt, type ClaudeCliOptions } from "./claude-cli.service.js";
import type { TrainAgentRunner } from "./merge-train-agent-fix.js";

export interface OneShotJsonResult {
  text: string;
  sessionId?: string;
  tokens?: number;
  costUsd?: number;
}

/** Pure: read Claude's `--output-format json` result from stdout (the last JSON object line). Null when it is not one. */
export function parseOneShotJsonResult(stdout: string): OneShotJsonResult | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }
    if (parsed.type !== "result") continue;
    if (parsed.is_error === true) throw new Error(`agent run failed: ${String(parsed.result ?? parsed.subtype ?? "unknown").slice(0, 300)}`);
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens = n(usage.input_tokens) + n(usage.output_tokens) + n(usage.cache_creation_input_tokens);
    return {
      text: String(parsed.result ?? ""),
      ...(typeof parsed.session_id === "string" ? { sessionId: parsed.session_id } : {}),
      ...(usage.input_tokens !== undefined || usage.output_tokens !== undefined ? { tokens } : {}),
      ...(typeof parsed.total_cost_usd === "number" ? { costUsd: parsed.total_cost_usd } : {}),
    };
  }
  return null;
}

/** A resumed session that the machine running the turn does not hold (a worker has its own session store). */
export function isResumeMiss(message: string): boolean {
  return /no conversation found|session .*not found|could not resume/i.test(message);
}

export function createPlacedSessionRunner(deps: {
  database?: ClaudeCliOptions["database"];
  invoke?: (prompt: string, opts: ClaudeCliOptions) => Promise<string>;
} = {}): TrainAgentRunner {
  const invoke = deps.invoke ?? invokeClaudePrompt;
  return async ({ worktree, prompt, timeoutMs, resumeSessionId, projectId, repoPath, baseBranch, label }) => {
    let worker: string | undefined;
    const call = (text: string, resume?: string) => invoke(text, {
      cwd: worktree, timeout: timeoutMs, allowEdits: true, json: true,
      ...(resume ? { resumeSessionId: resume } : {}),
      ...(deps.database ? { database: deps.database } : {}),
      onPlacement: (info) => { worker = info.worker; },
      // #1431: the worker edits a checkout of the train tree and its commits are fast-forwarded into `worktree`.
      ...(projectId && repoPath ? { projectId, repo: { repoPath, ...(baseBranch ? { baseBranch } : {}), ...(label ? { keepFixAs: label } : {}) } } : {}),
    });
    let raw: string;
    try {
      raw = await call(prompt, resumeSessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!resumeSessionId || !isResumeMiss(message)) throw err;
      // The turn landed on a machine without the shepherd's session: start a fresh one and say so.
      raw = await call(`(Your earlier session is not available on this machine; its context is gone. Re-read the tree.)\n\n${prompt}`);
    }
    const parsed = parseOneShotJsonResult(raw);
    return {
      ...(parsed?.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(parsed?.tokens !== undefined ? { tokens: parsed.tokens } : {}),
      ...(parsed?.costUsd !== undefined ? { costUsd: parsed.costUsd } : {}),
      ...(worker ? { worker } : {}),
    };
  };
}
