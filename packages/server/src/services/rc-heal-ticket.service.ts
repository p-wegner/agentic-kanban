/**
 * The release-candidate **heal ticket** (#1239, decision 019 part 2).
 *
 * `pnpm promote` sweeps an `rc/<date>` branch (#1238, `probeBranch`). When that sweep is RED the
 * red is not master's — master keeps merging — it is the candidate's, and the candidate is
 * fixed FORWARD: an ordinary builder ticket whose workspace is based on the rc, rebases onto it,
 * and merges into it. This module files that ticket, and later closes or retargets it.
 *
 * It reuses #1233's identity machinery (`heal-failure-signature.ts`, `heal-ticket-key.ts`) with
 * one more key segment — the rc branch — so the invariant "at most one OPEN heal ticket per
 * failure signature" holds PER CANDIDATE: a second red rc sweep with the same failing set
 * refreshes the open ticket, a different failing set files a second beside it, and the same set
 * on the NEXT rc is a new ticket because it is a different tree.
 *
 * Where it deliberately differs from `base-health-heal-ticket.service.ts`:
 *
 *  - **No policy gate.** #1233's ticket is a disclosure that only `allow-file-debt-ticket`
 *    projects need; this ticket IS the heal mechanism, and a project that runs `pnpm promote`
 *    has opted into the rc lane by doing so. Every posture files it.
 *  - **A green rc sweep closes nothing.** The fix reaches master through the merge-back
 *    workspace (`rc-merge-back.service.ts`), and THAT landing closes the tickets — closing them
 *    on green would leave a healed rc whose fix never reached master with no open ticket saying
 *    so. A green sweep comments instead.
 *  - **Abandon retargets.** A candidate red for longer than one cadence is abandoned and a fresh
 *    one cut (#1238's `planRcCandidate`); its open heal tickets move to the new rc — key,
 *    comment, and the base of every open workspace — rather than closing unhealed.
 *
 * Everything here is best-effort and never throws: it hangs off a health probe and off a
 * promotion, neither of which may fail over ticket bookkeeping.
 */
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
import { canonicalFailedSuites, failureSignature } from "../lib/heal-failure-signature.js";
import {
  HEAL_TICKET_TAG,
  healTicketExternalKey,
  healTicketKeyScanPrefix,
  parseHealTicketExternalKey,
  parseMergeBackExternalKey,
} from "../lib/heal-ticket-key.js";
import type { BaseBranchHealthOutcome } from "../repositories/base-branch-health.repository.js";
import { decodeFailedSuites, getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getDoneStatusIds, updateIssueById } from "../repositories/issue-service.repository.js";
import { getIssueExternalKey, getMinIssueSortOrder, listIssuesByExternalKeyPrefix } from "../repositories/issue/heal-ticket.repository.js";
import { listOpenWorkspacesForIssue, setWorkspaceBaseBranch } from "../repositories/workspace-heal.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { RISK_TAG_PREFIX } from "./risk-posture.service.js";

/**
 * `heal_review_posture_<projectId>` (#1239): when set to a risk level, every rc heal ticket is
 * born with the `risk:<level>` tag, pinning its per-ticket review posture (`standard` is the
 * intended value — a heal is where a stricter review is cheap and a wrong fix is expensive).
 * Unset = the project's own posture, exactly as for any other ticket.
 */
const healReviewPosturePref = projectPref("heal_review_posture");

const MAX_LISTED_COMMITS = 60;

export type RcHealAction = "created" | "updated" | "commented" | "closed" | "retargeted" | "skipped_no_verdict" | "noop";

export interface RcHealResult {
  action: RcHealAction;
  reason: string;
  issueIds: string[];
  issueNumbers: number[];
}

export interface RcSweepInput {
  projectId: string;
  /** The candidate branch, `rc/<date>[-N]`. */
  rcBranch: string;
  /** The rc sha the sweep verified. */
  sha: string;
  outcome: BaseBranchHealthOutcome;
  failedSuites?: string[] | null;
  healthRowId?: string | null;
  /** Tail of the verify output, when the sweep captured one. */
  message?: string;
  /** The project's MAIN checkout, for the merges-in-range list. */
  repoPath?: string | null;
  /** The lower bound of the merge range: the previous green rc, else master's last green sweep. */
  lastGreenSha?: string | null;
  /** What that lower bound WAS, for the body (`rc/20260924`, `master (nightly sweep)`). */
  lastGreenLabel?: string | null;
  /** The project's `verify_script`, for the reproduce line; null = the generic instruction. */
  verifyScript?: string | null;
  /** ISO; persisted onto comments and status stamps, hence `now?: string`. */
  now?: string;
  /** Injected issue creator — defaults to the real `issue.service` one. */
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
}

type HealTicketRow = Awaited<ReturnType<typeof listIssuesByExternalKeyPrefix>>[number] & { externalKey: string };

/** Every OPEN heal ticket keyed to `rcBranch` in this project. */
export async function listOpenRcHealTickets(projectId: string, rcBranch: string, database: Database = db): Promise<HealTicketRow[]> {
  const rows = await listIssuesByExternalKeyPrefix(projectId, healTicketKeyScanPrefix(projectId), database);
  return rows.filter((row): row is HealTicketRow => {
    if (!row.externalKey || LEGACY_TERMINAL_STATUS_NAMES.has(row.statusName ?? "")) return false;
    const parsed = parseHealTicketExternalKey(row.externalKey);
    return parsed?.projectId === projectId && parsed.branch === rcBranch;
  });
}

/**
 * Reconcile a candidate's heal tickets against one rc sweep verdict. Red files or refreshes ONE
 * ticket for the verdict's failure signature; green comments on every open one (the merge-back
 * closes them); a non-verdict does nothing. Never throws.
 */
export async function reconcileRcSweep(input: RcSweepInput, database: Database = db): Promise<RcHealResult> {
  const { projectId, rcBranch, outcome } = input;
  try {
    if (outcome !== "red" && outcome !== "green") {
      return { action: "skipped_no_verdict", reason: `rc sweep outcome '${outcome}' is not a verdict about ${rcBranch}`, issueIds: [], issueNumbers: [] };
    }
    const open = await listOpenRcHealTickets(projectId, rcBranch, database);
    if (outcome === "green") return await commentGreen(input, open, database);
    return await fileOrRefresh(input, open, database);
  } catch (err) {
    console.warn(`[rc-heal] reconcile failed for ${rcBranch} in project ${projectId} (non-fatal):`, err instanceof Error ? err.message : String(err));
    return { action: "noop", reason: `reconcile failed: ${err instanceof Error ? err.message : String(err)}`, issueIds: [], issueNumbers: [] };
  }
}

async function fileOrRefresh(input: RcSweepInput, open: HealTicketRow[], database: Database): Promise<RcHealResult> {
  const signature = failureSignature(input.failedSuites);
  const externalKey = healTicketExternalKey(input.projectId, signature, input.rcBranch);
  const existing = open.find((row) => row.externalKey === externalKey);
  const title = rcHealTicketTitle(input.rcBranch, input.failedSuites);
  const commits = await listCommitsInRange(input);
  const body = rcHealTicketBody(input, commits);
  const now = input.now ?? new Date().toISOString();

  console.log(
    `[rc-heal] project ${input.projectId}: ${input.rcBranch} is RED at ${shortSha(input.sha)} — `
      + `${existing ? `refreshing heal ticket #${existing.issueNumber}` : "filing heal ticket"}: "${title}" (key ${externalKey})`,
  );

  if (existing) {
    await updateIssueById(existing.id, { title, description: body, priority: "critical", updatedAt: now }, database);
    return {
      action: "updated",
      reason: `heal ticket #${existing.issueNumber} refreshed — same failure signature ${signature} on ${input.rcBranch} at ${shortSha(input.sha)}`,
      issueIds: [existing.id],
      issueNumbers: existing.issueNumber != null ? [existing.issueNumber] : [],
    };
  }

  const createIssue = input.createIssue ?? createIssueService({ database }).createIssue;
  const minSort = await getMinIssueSortOrder(input.projectId, database);
  const issue = await createIssue({
    projectId: input.projectId,
    title,
    description: body,
    issueType: "task",
    priority: "critical",
    sortOrder: (minSort ?? 0) - 1,
    externalKey,
    // Born tagged (no `no-auto-start`: the monitor starts it within WIP like any critical ticket).
    tags: [HEAL_TICKET_TAG, ...(await healReviewPostureTag(input.projectId, database))],
  });
  return {
    action: "created",
    reason: `filed heal ticket #${issue.issueNumber ?? "?"} for ${input.rcBranch} red at ${shortSha(input.sha)} (signature ${signature})`,
    issueIds: [issue.id],
    issueNumbers: issue.issueNumber != null ? [issue.issueNumber] : [],
  };
}

async function commentGreen(input: RcSweepInput, open: HealTicketRow[], database: Database): Promise<RcHealResult> {
  if (open.length === 0) return { action: "noop", reason: `${input.rcBranch} is green and no heal ticket is open for it`, issueIds: [], issueNumbers: [] };
  const now = input.now ?? new Date().toISOString();
  const note = `Release candidate \`${input.rcBranch}\` swept GREEN at ${shortSha(input.sha)}. `
    + `This ticket closes when the merge-back workspace lands the candidate on master (#1239).`;
  for (const ticket of open) {
    await insertIssueComment({ issueId: ticket.id, kind: "note", author: "system", body: note, createdAt: now }, database).catch(() => {});
  }
  return {
    action: "commented",
    reason: `${open.length} heal ticket(s) told ${input.rcBranch} is green; the merge-back closes them`,
    issueIds: open.map((t) => t.id),
    issueNumbers: open.flatMap((t) => (t.issueNumber != null ? [t.issueNumber] : [])),
  };
}

/** `["risk:<level>"]` when `heal_review_posture_<projectId>` names a valid level, else `[]`. */
async function healReviewPostureTag(projectId: string, database: Database): Promise<string[]> {
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  const level = (prefMap.get(healReviewPosturePref.key(projectId)) ?? "").trim();
  return level && (RISK_POSTURES as readonly string[]).includes(level) ? [`${RISK_TAG_PREFIX}${level}`] : [];
}

// --- close (merge-back landed) and retarget (rc abandoned) -----------------------------------

/** Close every open heal ticket of `rcBranch` with `note`; a project without a Done column keeps them open, commented. */
export async function closeRcHealTickets(
  args: { projectId: string; rcBranch: string; note: string; now?: string },
  database: Database = db,
): Promise<RcHealResult> {
  try {
    const open = await listOpenRcHealTickets(args.projectId, args.rcBranch, database);
    if (open.length === 0) return { action: "noop", reason: `no open heal ticket for ${args.rcBranch}`, issueIds: [], issueNumbers: [] };
    const now = args.now ?? new Date().toISOString();
    const doneStatusIds = await getDoneStatusIds(args.projectId, database);
    const closed: HealTicketRow[] = [];
    for (const ticket of open) {
      console.log(`[rc-heal] project ${args.projectId}: closing heal ticket #${ticket.issueNumber} — ${args.note}`);
      await insertIssueComment({ issueId: ticket.id, kind: "note", author: "system", body: args.note, createdAt: now }, database).catch(() => {});
      if (doneStatusIds.length === 0) continue;
      await updateIssueById(ticket.id, { statusId: doneStatusIds[0], statusChangedAt: now, updatedAt: now }, database);
      closed.push(ticket);
    }
    return {
      action: closed.length > 0 ? "closed" : "commented",
      reason: closed.length > 0 ? `${closed.length} heal ticket(s) closed for ${args.rcBranch}` : `${open.length} heal ticket(s) commented but left open — project has no 'Done' status`,
      issueIds: (closed.length > 0 ? closed : open).map((t) => t.id),
      issueNumbers: (closed.length > 0 ? closed : open).flatMap((t) => (t.issueNumber != null ? [t.issueNumber] : [])),
    };
  } catch (err) {
    console.warn(`[rc-heal] close failed for ${args.rcBranch} (non-fatal):`, err instanceof Error ? err.message : String(err));
    return { action: "noop", reason: `close failed: ${err instanceof Error ? err.message : String(err)}`, issueIds: [], issueNumbers: [] };
  }
}

/**
 * A merged workspace whose issue is the MERGE-BACK of an rc (`rc-merge-back:<project>:<rc>`)
 * closes that rc's heal tickets — the fix is on master now. Any other issue: no-op. Called from
 * `finalizeMergeCleanup`, so both the single-workspace merge and the train close them.
 */
export async function closeHealTicketsForMergedIssue(
  args: { issueId: string; projectId: string | null; now?: string },
  database: Database = db,
): Promise<RcHealResult | null> {
  const key = await getIssueExternalKey(args.issueId, database).catch(() => null);
  const mergeBack = parseMergeBackExternalKey(key);
  if (!mergeBack || !args.projectId) return null;
  return closeRcHealTickets({
    projectId: args.projectId,
    rcBranch: mergeBack.branch,
    note: `The merge-back of \`${mergeBack.branch}\` landed on master through the board — the fix this ticket healed on the candidate has reached master.`,
    now: args.now,
  }, database);
}

/**
 * An abandoned rc's open heal tickets move to the NEXT candidate (#1239 item 4): the key's
 * branch segment, a comment naming both, and the base of every open workspace — so
 * `update-base` rebases onto the new rc and the merge targets it. Nothing is closed.
 */
export async function retargetRcHealTickets(
  args: { projectId: string; fromBranch: string; toBranch: string; now?: string },
  database: Database = db,
): Promise<RcHealResult> {
  try {
    const open = await listOpenRcHealTickets(args.projectId, args.fromBranch, database);
    if (open.length === 0) return { action: "noop", reason: `no open heal ticket on ${args.fromBranch} to retarget`, issueIds: [], issueNumbers: [] };
    const now = args.now ?? new Date().toISOString();
    const note = `Release candidate \`${args.fromBranch}\` was abandoned (red for longer than one cadence); this ticket now heals \`${args.toBranch}\`. `
      + `Its workspace's base moved with it: rebase (update-base) onto \`${args.toBranch}\` before continuing.`;
    let workspacesMoved = 0;
    for (const ticket of open) {
      const parsed = parseHealTicketExternalKey(ticket.externalKey);
      const newKey = healTicketExternalKey(args.projectId, parsed?.signature ?? "verify-failed", args.toBranch);
      await updateIssueById(ticket.id, { externalKey: newKey, updatedAt: now }, database);
      await insertIssueComment({ issueId: ticket.id, kind: "note", author: "system", body: note, createdAt: now }, database).catch(() => {});
      for (const ws of await listOpenWorkspacesForIssue(ticket.id, database)) {
        if (ws.baseBranch !== args.fromBranch) continue;
        await setWorkspaceBaseBranch(ws.id, { baseBranch: args.toBranch, updatedAt: now }, database);
        workspacesMoved++;
      }
      console.log(`[rc-heal] project ${args.projectId}: heal ticket #${ticket.issueNumber} retargeted ${args.fromBranch} -> ${args.toBranch}`);
    }
    return {
      action: "retargeted",
      reason: `${open.length} heal ticket(s) and ${workspacesMoved} workspace base(s) moved ${args.fromBranch} -> ${args.toBranch}`,
      issueIds: open.map((t) => t.id),
      issueNumbers: open.flatMap((t) => (t.issueNumber != null ? [t.issueNumber] : [])),
    };
  } catch (err) {
    console.warn(`[rc-heal] retarget ${args.fromBranch} -> ${args.toBranch} failed (non-fatal):`, err instanceof Error ? err.message : String(err));
    return { action: "noop", reason: `retarget failed: ${err instanceof Error ? err.message : String(err)}`, issueIds: [], issueNumbers: [] };
  }
}

// --- the read model (delivery view, tracker, Sentinel) -----------------------------------------

export interface RcHealSummary {
  openHealTickets: number;
  /** Failing rc suites that master's latest sweep ALSO names as red — red the candidate inherited. */
  inheritedRed: number;
}

/** Pure: how many of the rc's failing suites master's latest red sweep also fails. */
export function countInheritedRed(rcFailedSuites: readonly string[] | null | undefined, masterFailedSuites: readonly string[] | null | undefined): number {
  const master = new Set(canonicalFailedSuites(masterFailedSuites));
  return canonicalFailedSuites(rcFailedSuites).filter((s) => master.has(s)).length;
}

export async function rcHealSummary(
  projectId: string,
  rc: { branch: string; failedSuites: readonly string[] } | null,
  database: Database = db,
): Promise<RcHealSummary | null> {
  if (!rc) return null;
  const [open, masterLatest] = await Promise.all([
    listOpenRcHealTickets(projectId, rc.branch, database).catch(() => []),
    getLatestBaseBranchHealth(projectId, database).catch(() => null),
  ]);
  return {
    openHealTickets: open.length,
    inheritedRed: masterLatest?.outcome === "red" ? countInheritedRed(rc.failedSuites, decodeFailedSuites(masterLatest.failedSuites)) : 0,
  };
}

// --- the ticket text ----------------------------------------------------------------------------

export function rcHealTicketTitle(rcBranch: string, failedSuites: string[] | null | undefined): string {
  const n = canonicalFailedSuites(failedSuites).length;
  const what = n === 0 ? "verify failed" : `${n} failing suite${n === 1 ? "" : "s"}`;
  return `heal: release candidate '${rcBranch}' is red (${what})`;
}

/**
 * The exact command to reproduce ONE suite. A vitest suite under `packages/<pkg>/` runs from
 * that package (the repo's convention); anything else runs through the project's verify script.
 */
export function reproduceSuiteCommand(suite: string, verifyScript: string | null | undefined): string {
  const m = /^packages\/([^/]+)\/(.+\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js))$/.exec(suite.replace(/\\/g, "/"));
  if (m) return `cd packages/${m[1]} && pnpm --silent exec vitest run ${m[2]} --maxWorkers=2`;
  return verifyScript ? `${verifyScript}   # the project's verify script; narrow it to ${suite}` : `run the project's verify script narrowed to ${suite}`;
}

export function rcHealTicketBody(input: RcSweepInput, commitsInRange: string[] | null = null): string {
  const suites = canonicalFailedSuites(input.failedSuites);
  const lines: string[] = [
    `The release-candidate sweep ran the project's \`verify_script\` against \`${input.rcBranch}\` and it FAILED.`,
    `Heal it ON the candidate: this ticket's workspace is based on \`${input.rcBranch}\`, rebases onto it and merges into it — never onto master.`,
    ``,
    `- Release candidate: \`${input.rcBranch}\``,
    `- Rc sha: \`${input.sha}\``,
    `- Failure signature: \`${failureSignature(input.failedSuites)}\``,
    `- Previous green: ${input.lastGreenSha ? `\`${input.lastGreenSha}\`${input.lastGreenLabel ? ` (${input.lastGreenLabel})` : ""}` : "_none recorded_"}`,
    `- Sweep row: \`base_branch_health\` id \`${input.healthRowId ?? "(not recorded)"}\``
      + ` — \`GET /api/projects/${input.projectId}/base-branch-health?branch=${input.rcBranch}\` shows the candidate's sweeps.`,
    ``,
    `## Failing suites`,
    ``,
    suites.length > 0
      ? suites.map((s) => `- \`${s}\``).join("\n")
      : `_The sweep reported no per-suite verdict (the verify command failed before or outside the suite list)._`,
    ``,
    `## Reproduce one suite`,
    ``,
    "```",
    reproduceSuiteCommand(suites[0] ?? "<suite>", input.verifyScript),
    "```",
    ``,
    `## Merges landed between the previous green and this cut`,
    ``,
    ...describeCommitsInRange(input, commitsInRange),
  ];
  if (input.message?.trim()) lines.push(``, `## Verify output (tail)`, ``, "```", input.message.trim(), "```");
  lines.push(
    ``,
    `---`,
    ``,
    `Filed by the rc sweep (decision 019). The pre-merge gate of this ticket's workspace runs against the`,
    `candidate's tree with the failing suites forced into its selection. When the candidate sweeps green it`,
    `is promoted, and a merge-back workspace lands \`${input.rcBranch}\` on master through the board's normal`,
    `gate — that landing closes this ticket. A candidate red for longer than one cadence is abandoned and`,
    `this ticket moves to the next one (a comment says so).`,
  );
  return lines.join("\n");
}

function describeCommitsInRange(input: RcSweepInput, commits: string[] | null): string[] {
  if (!input.lastGreenSha) return [`_No green sweep is recorded for this project, so there is no lower bound to list from._`];
  if (input.lastGreenSha === input.sha) return [`_This sha was already swept green; the red is not attributable to a landing._`];
  if (commits === null) return [`_Could not read \`git log ${shortSha(input.lastGreenSha)}..${shortSha(input.sha)}\` from the project checkout._`];
  if (commits.length === 0) return [`_No commits between the previous green and this candidate._`];
  const shown = commits.slice(0, MAX_LISTED_COMMITS).map((c) => `- \`${c}\``);
  if (commits.length > MAX_LISTED_COMMITS) shown.push(`- _… and ${commits.length - MAX_LISTED_COMMITS} more_`);
  return [`\`git log ${shortSha(input.lastGreenSha)}..${shortSha(input.sha)} --oneline\` (${commits.length}):`, ``, ...shown];
}

async function listCommitsInRange(input: RcSweepInput): Promise<string[] | null> {
  if (!input.repoPath || !input.lastGreenSha || input.lastGreenSha === input.sha) return null;
  const result = await gitExec(["log", "--oneline", "--no-decorate", `${input.lastGreenSha}..${input.sha}`], { cwd: input.repoPath, timeout: 30_000 });
  if (!execSucceeded(result)) return null;
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
