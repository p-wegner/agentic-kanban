/**
 * The in-train FIX AGENT (#1277): what a red merge train tries BEFORE the control arm + bisect.
 *
 * MEASURED motivation: `train/2026-10-01-01` went red on a shared ratchet that passes alone on
 * every member's branch, and sat in the control arm + bisect for 20+ minutes. A red like that is a
 * cross-member interaction; one directed agent with the whole assembled tree in front of it
 * resolves it in minutes, where bisect can only attribute it to a member and send that member
 * back for a full rebuild.
 *
 * It runs INSIDE the staging gate's worktree (`runTrainStagingGate`'s `onRed`), so the tree
 * already has its dependencies installed and the agent can only write there (the one-shot is
 * launched with `KANBAN_WORKTREE_DIR` set to it, #959/#369). The agent's commits land on the train
 * ref; the gate is then re-run on that tree and, when green, THAT tree lands. Everything outside
 * the worktree is untouched, and no ticket is created: the work is a train-level attempt.
 *
 * Pure orchestration over ports (`runAgent`, `regate`, git), so the cap behaviour is testable
 * without an agent, a gate or a repo.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { MergeTrainAgentFixDto, MergeTrainAttemptDto } from "@agentic-kanban/shared/types";
import type { MergeTrainAgentFixCaps } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { invokeClaudePrompt, type ClaudeCliOptions } from "./claude-cli.service.js";

/** What one gate run says, as far as the fix agent cares. */
export interface AgentFixGateVerdict {
  passed: boolean;
  message: string;
  failedSuites?: string[];
}

/** One agent turn. Throws when the agent could not run or timed out; usage is optional. */
export type TrainAgentRunner = (args: {
  worktree: string;
  prompt: string;
  timeoutMs: number;
  turn: number;
  /** #1431: with these the turn is placed like a session (a worker edits a checkout of the train tree). */
  projectId?: string;
  repoPath?: string;
  baseBranch?: string;
}) => Promise<{ sessionId?: string; tokens?: number; costUsd?: number }>;

export interface AgentFixMember {
  workspaceId: string;
  issueNumber?: number | null;
  branch: string;
}

/** The brief the agent is given: the failing suites, the output tail, the members, the scope. Pure. */
export function buildAgentFixBrief(args: {
  label: string;
  baseBranch: string;
  members: readonly AgentFixMember[];
  failedSuites?: readonly string[];
  failureMessage: string;
  turn: number;
}): string {
  const members = args.members
    .map((m) => `- ${m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId.slice(0, 8)} (${m.branch})`)
    .join("\n");
  const suites = args.failedSuites && args.failedSuites.length > 0
    ? args.failedSuites.map((s) => `- ${s}`).join("\n")
    : "- (the gate named none; read the output below)";
  const tail = args.failureMessage.split(/\r?\n/).slice(-60).join("\n").slice(-6000);
  return [
    `# Fix the red merge train ${args.label}${args.turn > 1 ? ` (turn ${args.turn}: your last fix did not turn the gate green)` : ""}`,
    "",
    `The working directory is the assembled train tree: ${args.members.length} member branch(es) merged onto \`${args.baseBranch}\`.`,
    "Each member is green on its own branch; the combination is red, so the cause is usually an interaction",
    "between members (a shared ratchet, a widened type, a drifted snapshot, a duplicated declaration).",
    "",
    "## Members",
    members,
    "",
    "## Failing suites",
    suites,
    "",
    "## Gate output (tail)",
    "```",
    tail,
    "```",
    "",
    "## Scope",
    "- Make the failing suite(s) pass so this train is green.",
    "- Do NOT revert or undo any member's intent; change the smallest thing that resolves the interaction.",
    "- Work ONLY inside this directory. Do not touch other checkouts or any branch ref.",
    "- Run the failing suite(s) to confirm, then COMMIT your change here (a plain commit on the current branch).",
    "- Do not create tickets or comments; just fix and commit.",
  ].join("\n");
}

async function headSha(worktree: string): Promise<string> {
  return (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: worktree })).trim();
}

/** Commit whatever the agent left uncommitted, so the re-gate sees (and the landing carries) it. */
async function commitLeftovers(worktree: string, label: string): Promise<void> {
  const status = await gitExec(["status", "--porcelain"], { cwd: worktree });
  if (status.error || !status.stdout.trim()) return;
  await gitExecOrThrow(["add", "-A"], { cwd: worktree });
  await gitExecOrThrow(["commit", "-m", `fix(merge-train): agent fix for ${label}`], { cwd: worktree });
}

export interface AgentFixOutcome {
  /** The attempt row to persist beside the bisect rows. */
  attempt: MergeTrainAttemptDto;
  /** Set only when the re-gate was green: the train ref's new tip, which is what must land. */
  fixedTrainSha?: string;
  /** The last gate verdict (the fix's re-gate), when one ran; the caller reports it on red. */
  lastGate?: AgentFixGateVerdict;
}

/**
 * Run the fix agent against `worktree`, re-gating after each turn, within the caps. Never throws:
 * an agent that could not run is a `red` row, a tripped cap a `capped` one, and either way the
 * caller falls back per the project's strategy.
 */
export async function runAgentFix(args: {
  worktree: string;
  label: string;
  baseBranch: string;
  members: readonly AgentFixMember[];
  initialFailure: { message: string; failedSuites?: string[] };
  caps: MergeTrainAgentFixCaps;
  runAgent: TrainAgentRunner;
  /** Re-run the gate on the worktree's CURRENT tree. */
  regate: () => Promise<AgentFixGateVerdict>;
  /** #1431: forwarded to the runner so the turn can run on a fleet worker. */
  placement?: { projectId: string; repoPath: string };
  writeBrief?: (label: string, brief: string) => Promise<string | undefined>;
}): Promise<AgentFixOutcome> {
  const { worktree, label, caps } = args;
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let gateStartedAt: string | null = null;
  let gateFinishedAt: string | null = null;
  let turns = 0;
  let tokens = 0;
  let costUsd = 0;
  let sessionId: string | undefined;
  let briefUrl: string | undefined;
  let failure = args.initialFailure;
  let lastGate: AgentFixGateVerdict | undefined;
  let outcome: MergeTrainAgentFixDto["outcome"] = "red";
  let capped: MergeTrainAgentFixDto["capped"];
  let reason = "";
  let fixedTrainSha: string | undefined;

  const baseHead = await headSha(worktree).catch(() => null);
  while (turns < caps.maxTurns) {
    const remaining = caps.timeoutMs - (Date.now() - startedMs);
    if (remaining <= 0) { outcome = "capped"; capped = "timeout"; reason = `fix agent exceeded ${caps.timeoutMs}ms`; break; }
    turns++;
    const brief = buildAgentFixBrief({
      label, baseBranch: args.baseBranch, members: args.members,
      failedSuites: failure.failedSuites, failureMessage: failure.message, turn: turns,
    });
    briefUrl ??= await (args.writeBrief ?? writeBriefFile)(label, brief).catch(() => undefined);
    try {
      const run = await args.runAgent({
        worktree, prompt: brief, timeoutMs: remaining, turn: turns,
        ...(args.placement ? { ...args.placement, baseBranch: args.baseBranch } : {}),
      });
      sessionId = run.sessionId ?? sessionId;
      tokens += run.tokens ?? 0;
      costUsd += run.costUsd ?? 0;
    } catch (err) {
      reason = errorMessage(err).slice(0, 300);
      if (/timed out/i.test(reason)) { outcome = "capped"; capped = "timeout"; } else { outcome = "red"; }
      break;
    }
    if (costUsd > caps.costCapUsd) { outcome = "capped"; capped = "cost"; reason = `fix agent cost $${costUsd.toFixed(2)} passed the $${caps.costCapUsd} cap`; break; }
    try {
      await commitLeftovers(worktree, label);
    } catch (err) {
      outcome = "red"; reason = `could not commit the agent's change: ${errorMessage(err).slice(0, 200)}`; break;
    }
    const head = await headSha(worktree).catch(() => null);
    if (!head || head === baseHead) { outcome = "capped"; capped = "no-change"; reason = "fix agent made no change"; break; }
    gateStartedAt ??= new Date().toISOString();
    lastGate = await args.regate();
    gateFinishedAt = new Date().toISOString();
    if (lastGate.passed) { outcome = "green"; fixedTrainSha = head; break; }
    outcome = "red";
    reason = lastGate.message;
    failure = { message: lastGate.message, failedSuites: lastGate.failedSuites };
  }

  const verdict = outcome === "green" ? "agent_fix_green" : outcome === "capped" ? "agent_fix_capped" : "agent_fix_red";
  const agentFix: MergeTrainAgentFixDto = {
    outcome,
    ...(capped ? { capped } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(briefUrl ? { briefUrl } : {}),
    durationMs: Date.now() - startedMs,
    ...(tokens > 0 ? { tokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
  const attempt: MergeTrainAttemptDto = {
    kind: "agent_fix",
    agentFix,
    label: `${label}f`,
    members: args.members.map((m) => m.workspaceId),
    included: args.members.map((m) => m.workspaceId),
    dropped: [],
    gateStartedAt: gateStartedAt ?? startedAt,
    gateFinishedAt: gateFinishedAt ?? new Date().toISOString(),
    gateRuns: gateStartedAt ? 1 : 0,
    verdict,
    ...(outcome !== "green" && reason ? { failureHead: reason.slice(0, 300) } : {}),
  };
  return { attempt, ...(fixedTrainSha ? { fixedTrainSha } : {}), ...(lastGate ? { lastGate } : {}) };
}

/**
 * #1513: the one log line when the fix agent is done. Names EVERY failing suite (the old line cut
 * the reason at 160 chars, so the suite list of train/2026-10-15-19 was lost) and says what
 * happens next, so a red end is never silent.
 */
export function describeAgentFixFinished(label: string, outcome: AgentFixOutcome, bisectAfter: boolean): string {
  const suites = outcome.lastGate?.failedSuites ?? [];
  const named = suites.length > 0 ? ` [failing suite(s), all ${suites.length}: ${suites.join(", ")}]` : "";
  const next = outcome.fixedTrainSha ? ""
    : bisectAfter ? "; falling back to the bisect"
    : "; no fix turns left - the train ends red, members get the failure as feedback, nothing is bisected";
  const head = outcome.attempt.failureHead ? `: ${outcome.attempt.failureHead}` : "";
  return `[merge-train] ${label}: fix agent finished - ${outcome.attempt.verdict}${head}${named}${next}`;
}

async function writeBriefFile(label: string, brief: string): Promise<string> {
  const path = join(tmpdir(), `kanban-train-fix-${label.replace(/[^A-Za-z0-9._-]/g, "-")}.md`);
  await writeFile(path, brief, "utf8");
  return pathToFileURL(path).href;
}

/**
 * The default runner: ONE agent turn through the board's one-shot provider path, so the
 * provider/profile selection is the regular one (the Strategy Bullseye's mirrored `provider` /
 * `*_profile` prefs, roster and allowlist included). The one-shot path reports no session id or
 * usage, so an operator's cost cap is enforced only for runners that do (the port allows it).
 */
export function createOneShotAgentRunner(deps: {
  database?: ClaudeCliOptions["database"];
  invoke?: (prompt: string, opts: ClaudeCliOptions) => Promise<string>;
} = {}): TrainAgentRunner {
  const invoke = deps.invoke ?? invokeClaudePrompt;
  return async ({ worktree, prompt, timeoutMs, projectId, repoPath, baseBranch }) => {
    await invoke(prompt, {
      cwd: worktree, timeout: timeoutMs, allowEdits: true, ...(deps.database ? { database: deps.database } : {}),
      // #1431: the worker edits a checkout of the train tree and its commits are fast-forwarded into `worktree`.
      ...(projectId && repoPath ? { projectId, repo: { repoPath, ...(baseBranch ? { baseBranch } : {}) } } : {}),
    });
    return {};
  };
}
