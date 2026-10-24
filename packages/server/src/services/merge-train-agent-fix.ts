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
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { MergeTrainAgentFixDto, MergeTrainAttemptDto } from "@agentic-kanban/shared/types";
import type { MergeTrainAgentFixCaps } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import type { Database } from "../db/index.js";
import { getLeadIssueForMembersBlock } from "../repositories/workspace-issue-members.repository.js";
import { invokeClaudePrompt, type ClaudeCliOptions } from "./claude-cli.service.js";

/** What one gate run says, as far as the fix agent cares. */
export interface AgentFixGateVerdict {
  passed: boolean;
  message: string;
  failedSuites?: string[];
  /** #1585: the re-gate was held/cancelled/timed out - nothing was verified and nothing failed. */
  inconclusive?: boolean;
}

/** One agent turn. Throws when the agent could not run or timed out; usage is optional. */
export type TrainAgentRunner = (args: {
  worktree: string;
  prompt: string;
  timeoutMs: number;
  turn: number;
  /** #1569: the shepherd's session from an earlier turn: resume it so its context (and cache) is reused. */
  resumeSessionId?: string;
  /** #1431: with these the turn is placed like a session (a worker edits a checkout of the train tree). */
  projectId?: string;
  repoPath?: string;
  baseBranch?: string;
  /** #1609: the train label; a fix that cannot be applied (train cancelled) is kept on `kanban/train-fix/<label>`. */
  label?: string;
}) => Promise<{ sessionId?: string; tokens?: number; costUsd?: number; /** #1572: the fleet worker the turn ran on. */ worker?: string }>;

export interface AgentFixMember {
  workspaceId: string;
  issueNumber?: number | null;
  branch: string;
  /** #1569: the board's own ticket text, so the shepherd knows what each member is FOR. */
  title?: string | null;
  description?: string | null;
  changedFiles?: readonly string[] | null;
}

const DESCRIPTION_LIMIT = 800;
const CHANGED_FILES_LIMIT = 15;

/** #1569: add the board's title and description to members that carry an `issueId`. Never throws. */
export async function enrichMembersWithTickets<M extends AgentFixMember & { issueId?: string }>(members: readonly M[], database: Database): Promise<M[]> {
  return Promise.all(members.map(async (m) => {
    if (!m.issueId) return m;
    const row = await getLeadIssueForMembersBlock(m.issueId, database).catch(() => undefined);
    return row ? { ...m, title: row.title, description: row.description } : m;
  }));
}

/** Pure: one member as the brief shows it (number, title, branch, trimmed description, changed files). */
export function describeMemberForBrief(m: AgentFixMember): string {
  const id = m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId.slice(0, 8);
  const lines = [`- ${id}${m.title ? ` ${m.title}` : ""} (${m.branch})`];
  const desc = (m.description ?? "").trim().replace(/\r?\n/g, "\n    ");
  if (desc) lines.push(`    ${desc.length > DESCRIPTION_LIMIT ? `${desc.slice(0, DESCRIPTION_LIMIT)}...` : desc}`);
  const files = m.changedFiles ?? [];
  if (files.length > 0) {
    const shown = files.slice(0, CHANGED_FILES_LIMIT).join(", ");
    lines.push(`    changed files: ${shown}${files.length > CHANGED_FILES_LIMIT ? `, +${files.length - CHANGED_FILES_LIMIT} more` : ""}`);
  }
  return lines.join("\n");
}

/** The brief the agent is given: the failing suites, the output tail, the members, the scope. Pure. */
export function buildAgentFixBrief(args: {
  label: string;
  baseBranch: string;
  members: readonly AgentFixMember[];
  failedSuites?: readonly string[];
  failureMessage: string;
  turn: number;
  /** #1572: the shepherd already carried the members in an earlier (conflict) turn. */
  membersAlreadySent?: boolean;
}): string {
  // #1569: only the FIRST turn carries the members; the shepherd session already holds them after that.
  const sent = args.turn > 1 || args.membersAlreadySent === true;
  const members = args.members.map(describeMemberForBrief).join("\n");
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
    ...(sent ? ["## Members", "(unchanged since your first brief)", ""] : ["## Members", members, ""]),
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
    "- The gate stops at its FIRST failing stage (check:arch, then typecheck, then tests): stages after it did NOT run,",
    "  so more failures may be hiding behind the one listed. Check your own work before you hand back.",
    "- BEFORE committing, run in this directory, in order: `pnpm check:arch`, `pnpm typecheck`, each failing suite",
    "  (`pnpm exec vitest run <file>`), and the impact selection of what you changed",
    "  (`node .claude/skills/test-impact/tools/impact.mjs select --min-score 1.0 --format vitest`, then run what it prints).",
    "  Fix every red one, so a single turn clears every stage and not just the first.",
    "- Known fix precedents (ratchets/tests pinning a member's deliberate change): see `docs/agent-guide/merge-trains.md`",
    "  \"fix precedents\". A new always-run guard with no `when:` territory raises `BASELINE_TOTAL_MS` with a written reason;",
    "  a test that pins behaviour a member changed on purpose is updated to the new behaviour.",
    "- Then COMMIT your change here (a plain commit on the current branch).",
    "- Do not create tickets or comments; just fix and commit.",
  ].join("\n");
}

/** #1569: how many times an infrastructure failure re-places the shepherd before the train is held. */
export const SHEPHERD_MAX_INFRA_RETRIES = 2;

/**
 * #1569: a failure of the PLACEMENT, not of the work: the worker went away, the session never
 * launched, or it ran for ~zero tokens. It says nothing about whether the gate can be fixed, so
 * it never counts as a turn and never as a red verdict.
 */
export function isInfraFailure(reason: string): boolean {
  return /disconnected|failed to launch|launch failed|could not (be )?(launch|place)|no worker|worker .*(offline|unavailable|lost)|ECONNRESET|ECONNREFUSED|zero tokens/i.test(reason);
}

type TurnErrorVerdict =
  | { retry: true }
  | { retry: false; infra: boolean; outcome: MergeTrainAgentFixDto["outcome"]; capped?: MergeTrainAgentFixDto["capped"]; reason: string };

/** #1569: what one thrown agent turn means. `infraRetries` already counts this failure. */
function classifyTurnError(reason: string, infraRetries: number): TurnErrorVerdict {
  if (isInfraFailure(reason)) {
    if (infraRetries <= SHEPHERD_MAX_INFRA_RETRIES) return { retry: true };
    return { retry: false, infra: true, outcome: "held", reason: `shepherd could not be placed after ${infraRetries} attempts: ${reason}` };
  }
  if (/timed out/i.test(reason)) return { retry: false, infra: false, outcome: "capped", capped: "timeout", reason };
  return { retry: false, infra: false, outcome: "red", reason };
}

const FIX_VERDICT: Record<MergeTrainAgentFixDto["outcome"], MergeTrainAttemptDto["verdict"]> = {
  green: "agent_fix_green", capped: "agent_fix_capped", held: "agent_fix_held", red: "agent_fix_red",
};

/** The persisted `agentFix` facts of one run, plus the attempt verdict they map to. */
function summarizeFixRun(r: Omit<MergeTrainAgentFixDto, "infraRetries" | "tokens" | "costUsd"> & { infraRetries: number; tokens: number; costUsd: number }) {
  const agentFix: MergeTrainAgentFixDto = {
    outcome: r.outcome,
    ...(r.capped ? { capped: r.capped } : {}),
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    ...(r.briefUrl ? { briefUrl: r.briefUrl } : {}),
    durationMs: r.durationMs,
    turns: r.turns,
    ...(r.infraRetries > 0 ? { infraRetries: r.infraRetries } : {}),
    ...(r.tokens > 0 ? { tokens: r.tokens } : {}),
    ...(r.costUsd > 0 ? { costUsd: r.costUsd } : {}),
  };
  return { verdict: FIX_VERDICT[r.outcome], agentFix };
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
  /** #1572: true when the runner's session already holds the member context (the shepherd ran conflict turns). */
  membersAlreadySent?: () => boolean;
  /** #1572: spend the shepherd's conflict turns already put on the shared cost cap. */
  priorCostUsd?: number;
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
  let infraRetries = 0;
  let outcome: MergeTrainAgentFixDto["outcome"] = "red";
  let capped: MergeTrainAgentFixDto["capped"];
  let reason = "";
  let fixedTrainSha: string | undefined;

  const baseHead = await headSha(worktree).catch(() => null);
  while (turns < caps.maxTurns) {
    // #1711: a missing cwd makes spawn report a misleading binary ENOENT. It is infrastructure, not a
    // red fix: hold the train, name the directory, and spend no turn.
    if (!existsSync(worktree)) {
      outcome = "held"; reason = `fix agent cwd missing: ${worktree}`; infraRetries++;
      console.warn(`[merge-train-agent-fix] ${label}: ${reason}`);
      break;
    }
    const remaining = caps.timeoutMs - (Date.now() - startedMs);
    if (remaining <= 0) { outcome = "capped"; capped = "timeout"; reason = `fix agent exceeded ${caps.timeoutMs}ms`; break; }
    turns++;
    const brief = buildAgentFixBrief({
      label, baseBranch: args.baseBranch, members: args.members,
      failedSuites: failure.failedSuites, failureMessage: failure.message, turn: turns,
      membersAlreadySent: args.membersAlreadySent?.() ?? false,
    });
    briefUrl ??= await (args.writeBrief ?? writeBriefFile)(label, brief).catch(() => undefined);
    try {
      const run = await args.runAgent({
        worktree, prompt: brief, timeoutMs: remaining, turn: turns, label,
        ...(sessionId ? { resumeSessionId: sessionId } : {}),
        ...(args.placement ? { ...args.placement, baseBranch: args.baseBranch } : {}),
      });
      sessionId = run.sessionId ?? sessionId;
      tokens += run.tokens ?? 0;
      costUsd += run.costUsd ?? 0;
      if (run.tokens === 0) throw new Error("shepherd session used zero tokens");
    } catch (err) {
      const verdict = classifyTurnError(errorMessage(err).slice(0, 300), infraRetries + 1);
      if (verdict.retry) { infraRetries++; turns--; continue; } // #1569: re-place the shepherd; consumes no turn.
      ({ outcome, capped, reason } = verdict);
      if (verdict.infra) { infraRetries++; turns--; } // the held outcome used no turn either.
      break;
    }
    if (costUsd + (args.priorCostUsd ?? 0) > caps.costCapUsd) { outcome = "capped"; capped = "cost"; reason = `fix agent cost $${(costUsd + (args.priorCostUsd ?? 0)).toFixed(2)} passed the $${caps.costCapUsd} cap`; break; }
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
    if (lastGate.inconclusive) { outcome = "capped"; capped = "gate-inconclusive"; reason = lastGate.message; break; }
    outcome = "red";
    reason = lastGate.message;
    failure = { message: lastGate.message, failedSuites: lastGate.failedSuites };
  }

  const { verdict, agentFix } = summarizeFixRun({ outcome, capped, sessionId, briefUrl, durationMs: Date.now() - startedMs, turns, infraRetries, tokens, costUsd });
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
  return `${label}: fix agent finished - ${outcome.attempt.verdict}${head}${named}${next}`;
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
  return async ({ worktree, prompt, timeoutMs, projectId, repoPath, baseBranch, label }) => {
    await invoke(prompt, {
      cwd: worktree, timeout: timeoutMs, allowEdits: true, ...(deps.database ? { database: deps.database } : {}),
      // #1431: the worker edits a checkout of the train tree and its commits are fast-forwarded into `worktree`.
      ...(projectId && repoPath ? { projectId, repo: { repoPath, ...(baseBranch ? { baseBranch } : {}), ...(label ? { keepFixAs: label } : {}) } } : {}),
    });
    return {};
  };
}
