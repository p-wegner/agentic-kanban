/**
 * The base-health **heal ticket** (#1016, per failure signature since #1233) — land-then-heal's
 * disclosure channel.
 *
 * Proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.B: once a project's effective
 * `redBasePolicy` is `allow-file-debt-ticket`, a red base stops withholding merges. That is only
 * honest if the red is written down somewhere a person or an agent will actually see it —
 * otherwise the posture has simply deleted the signal. So the sweep that produced the verdict
 * files ONE ticket per distinct failing set, carrying the failing-suite list, the base sha and
 * the merges that landed since the last green sweep, which one agent diagnoses instead of N
 * per-branch gates re-running the same suites and each charging the innocent branch for it.
 *
 * Five rules, all of them deliberate:
 *
 *  1. **Policy is read through the resolver, never the raw pref.** `resolveRiskPosture` is the
 *     one place the per-project override's softer-only direction check runs (#1015,
 *     `red-base-policy-raw-read-ratchet.test.ts`). A project on `block`, `allow-known-debt` or
 *     `report` gets NOTHING here — not a quieter ticket, not a comment. `block` means the gate
 *     already withheld the merge and the red is visible where it happened; `report` (#1233) is
 *     the explicit "disclose in the delivery view only" policy; the heal ticket exists only for
 *     the case where nothing else will say it.
 *  2. **Log first, then write.** The log line (plan item P1.10) names the ticket that would be
 *     filed, so the behaviour is observable in a transcript even when the write half fails or
 *     is short-circuited by idempotence. It is not a dry-run mode: the write (P2.3) follows.
 *  3. **At most one OPEN heal ticket per FAILURE SIGNATURE** (#1233), found by `external_key`
 *     (`healTicketExternalKey(projectId, failureSignature(failedSuites))`), never by title — a
 *     heal title carries the failing-suite count and changes on every sweep. A second red sweep
 *     with the same signature REFRESHES that ticket's body (sha, merges since); a red with a new
 *     signature files a second ticket beside it; a green sweep closes every open one with a
 *     comment saying which sha cleared it.
 *  4. **Top of the backlog, not outside the WIP limit.** No WIP-exemption mechanism exists in
 *     this board, and #1016 does not invent one. `priority: critical` plus a `sort_order` below
 *     every other issue in the project is the whole of "highest priority", and the `heal` tag
 *     is what the monitor and an operator list them by.
 *  5. **The merges since the last green are named, through the git adapter.** `git log
 *     <lastGreenSha>..<redSha> --oneline` is the suspect list for the builder that picks the
 *     ticket up; it is read via `@agentic-kanban/shared/lib/git-exec`, never a private spawn
 *     (`git-exec-single-spawn.test.ts`). Absent a last green, or with an unreadable repo, the
 *     section says so rather than guessing.
 *
 * A `timeout`/`unverified` sweep observed nothing about any suite, so it neither files nor
 * closes — the same contract `recordBaseSweepOutcome` applies to the outcome ledger, and for
 * the same reason: attributing a machine event to the base is a false verdict either way.
 *
 * Every failure path here is non-fatal to the caller. This is a disclosure channel hanging off
 * a health probe; a ticket that could not be written must not turn a green sweep into an error.
 */

import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { canonicalFailedSuites, failureSignature } from "../lib/heal-failure-signature.js";
import {
  HEAL_TICKET_TAG,
  healTicketExternalKey,
  healTicketKeyScanPrefix,
  parseHealTicketExternalKey,
} from "../lib/heal-ticket-key.js";
import type { BaseBranchHealthOutcome } from "../repositories/base-branch-health.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getDoneStatusIds, updateIssueById } from "../repositories/issue-service.repository.js";
import { getMinIssueSortOrder, listIssuesByExternalKeyPrefix } from "../repositories/issue/heal-ticket.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { applyIssueTag } from "./repo-tags.service.js";
import { resolveRiskPosture } from "./risk-posture.service.js";
import type { RiskPosture } from "./risk-posture.service.js";

/** Colour of the `heal` tag on first use — the board's red-ish debt colour. */
const HEAL_TAG_COLOR = "#dc2626";

/** How many `git log --oneline` lines the ticket body carries at most; the rest is counted. */
const MAX_LISTED_COMMITS = 60;

export type HealTicketAction =
  | "skipped_policy"
  | "skipped_no_verdict"
  | "created"
  | "updated"
  | "closed"
  | "noop";

export interface HealTicketReconcileResult {
  action: HealTicketAction;
  /** Human-readable reason, phrased for a log line and for a test assertion. */
  reason: string;
  issueId?: string;
  issueNumber?: number;
  /** Every heal ticket a green sweep closed (`closed` names the first one in `issueId`). */
  closedIssueIds?: string[];
}

export interface HealTicketReconcileInput {
  projectId: string;
  outcome: BaseBranchHealthOutcome;
  /** The base sha the sweep verified. */
  sha: string;
  /** The base branch name. */
  branch: string;
  /** Suites the sweep named as failed (`[]` = a verdict that named none). */
  failedSuites?: string[] | null;
  /** The `base_branch_health` row this sweep wrote — the ticket's reference back to the sweep. */
  healthRowId?: string | null;
  /** Tail of the verify output, when the sweep captured one. */
  message?: string;
  /** The project's checkout, for the merges-since-last-green list (#1233). */
  repoPath?: string | null;
  /** The sha of the last GREEN sweep, or null when there was none — the list's lower bound. */
  lastGreenSha?: string | null;
  /** Pre-resolved posture (tests, and any caller that already resolved one). */
  posture?: RiskPosture;
  /** Injected issue creator — defaults to the real `issue.service` one. */
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  /** ISO now; PERSISTED (status-change/updated stamps), hence `now?: string`. */
  now?: string;
}

/**
 * Reconcile a project's heal tickets against one base-health sweep verdict.
 *
 * Idempotent by construction: the same verdict applied twice creates one ticket and then
 * refreshes it. Never throws — see the header.
 */
export async function reconcileBaseHealthHealTicket(
  input: HealTicketReconcileInput,
  database: Database = db,
): Promise<HealTicketReconcileResult> {
  const { projectId, outcome } = input;
  try {
    const posture = input.posture ?? resolveRiskPosture(
      toPrefMap(await getAllPreferencesCached(database).catch(() => [])),
      projectId,
    );
    if (posture.redBasePolicy !== "allow-file-debt-ticket") {
      return {
        action: "skipped_policy",
        reason: `red-base policy '${posture.redBasePolicy}' does not file debt tickets `
          + `(risk posture '${posture.level}', source: ${posture.source})`,
      };
    }
    // A probe that could not answer says nothing about the base — it must neither file nor
    // close. `unverified` is the same case by a different door.
    if (outcome !== "red" && outcome !== "green") {
      return { action: "skipped_no_verdict", reason: `sweep outcome '${outcome}' is not a verdict about the base` };
    }

    const open = await listOpenHealTickets(projectId, database);
    if (outcome === "green") return await closeHealTickets({ input, database, open });
    return await fileOrRefreshHealTicket({ input, database, open });
  } catch (err) {
    // Non-fatal: this hangs off a health probe and must never fail one.
    console.warn(
      `[base-health-heal] reconcile failed for project ${projectId} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
    return { action: "noop", reason: `reconcile failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type HealTicketRow = Awaited<ReturnType<typeof listIssuesByExternalKeyPrefix>>[number] & { externalKey: string };

/**
 * Every OPEN heal ticket of a project, whatever its signature — including a pre-#1233 ticket
 * whose key carries no signature. The LIKE prefix is confirmed per row by parsing the key, so
 * a project id that happens to prefix another's cannot pull in a neighbour's tickets.
 */
export async function listOpenHealTickets(projectId: string, database: Database = db): Promise<HealTicketRow[]> {
  const rows = await listIssuesByExternalKeyPrefix(projectId, healTicketKeyScanPrefix(projectId), database);
  return rows.filter((row): row is HealTicketRow => {
    if (!row.externalKey) return false;
    if (LEGACY_TERMINAL_STATUS_NAMES.has(row.statusName ?? "")) return false;
    return parseHealTicketExternalKey(row.externalKey)?.projectId === projectId;
  });
}

async function fileOrRefreshHealTicket(args: {
  input: HealTicketReconcileInput;
  database: Database;
  open: HealTicketRow[];
}): Promise<HealTicketReconcileResult> {
  const { input, database, open } = args;
  const signature = failureSignature(input.failedSuites);
  const externalKey = healTicketExternalKey(input.projectId, signature);
  const existing = open.find((row) => row.externalKey === externalKey);
  const title = healTicketTitle(input.branch, input.failedSuites);
  const commits = await listCommitsSinceLastGreen(input);
  const body = healTicketBody(input, commits);

  // Step 1 (P1.10): say what would be filed, BEFORE filing it, so the decision is legible in a
  // transcript even if the write below fails.
  console.log(
    `[base-health-heal] project ${input.projectId}: base '${input.branch}' is RED at ${shortSha(input.sha)} — `
      + `${existing ? `refreshing heal ticket #${existing.issueNumber}` : "filing heal ticket"}: "${title}" `
      + `(key ${externalKey}, signature ${signature}, tag '${HEAL_TICKET_TAG}', priority critical, top of backlog`
      + `${open.length > (existing ? 1 : 0) ? `; ${open.length - (existing ? 1 : 0)} other heal ticket(s) open with a different signature` : ""})`,
  );

  const now = input.now ?? new Date().toISOString();
  if (existing) {
    // The same failing set again: refresh the sha and the merges-since list, file nothing new.
    await updateIssueById(existing.id, { title, description: body, priority: "critical", updatedAt: now }, database);
    return {
      action: "updated",
      reason: `heal ticket #${existing.issueNumber} refreshed — same failure signature ${signature} at ${shortSha(input.sha)}`,
      issueId: existing.id,
      issueNumber: existing.issueNumber ?? undefined,
    };
  }

  const createIssue = input.createIssue ?? createIssueService({ database }).createIssue;
  // Top of the backlog: the board orders columns by `sort_order` ascending.
  const minSort = await getMinIssueSortOrder(input.projectId, database);
  const issue = await createIssue({
    projectId: input.projectId,
    title,
    description: body,
    issueType: "task",
    priority: "critical",
    sortOrder: (minSort ?? 0) - 1,
    externalKey,
  });
  await applyIssueTag(issue.id, HEAL_TICKET_TAG, HEAL_TAG_COLOR, database).catch(() => {});
  return {
    action: "created",
    reason: `filed heal ticket #${issue.issueNumber ?? "?"} for a red base at ${shortSha(input.sha)} (signature ${signature})`,
    issueId: issue.id,
    issueNumber: issue.issueNumber ?? undefined,
  };
}

async function closeHealTickets(args: {
  input: HealTicketReconcileInput;
  database: Database;
  open: HealTicketRow[];
}): Promise<HealTicketReconcileResult> {
  const { input, database, open } = args;
  if (open.length === 0) return { action: "noop", reason: "base is green and no heal ticket is open" };

  const now = input.now ?? new Date().toISOString();
  const doneStatusIds = await getDoneStatusIds(input.projectId, database);
  const note = `Base branch '${input.branch}' verified GREEN at ${shortSha(input.sha)} by the base-health sweep — `
    + `the red this ticket was filed for is gone.`;
  const closedIssueIds: string[] = [];
  for (const ticket of open) {
    console.log(`[base-health-heal] project ${input.projectId}: closing heal ticket #${ticket.issueNumber} — ${note}`);
    // The comment first: if the status write fails, the ticket at least carries the reason it
    // should have closed. `author: "system"` puts it on the collapsing path, so a repeated green
    // bumps a repeat count instead of appending a row (#738).
    await insertIssueComment(
      { issueId: ticket.id, kind: "note", author: "system", body: note, createdAt: now },
      database,
    ).catch(() => {});
    if (doneStatusIds.length === 0) continue;
    await updateIssueById(ticket.id, { statusId: doneStatusIds[0], statusChangedAt: now, updatedAt: now }, database);
    closedIssueIds.push(ticket.id);
  }

  const first = open[0];
  if (doneStatusIds.length === 0) {
    // A project with no "Done" column can still be told; leaving them open is the safe half.
    return {
      action: "noop",
      reason: `${open.length} heal ticket(s) commented but left open — project has no 'Done' status`,
      issueId: first.id,
      issueNumber: first.issueNumber ?? undefined,
    };
  }
  return {
    action: "closed",
    reason: `${closedIssueIds.length} heal ticket(s) closed — base green at ${shortSha(input.sha)}`,
    issueId: first.id,
    issueNumber: first.issueNumber ?? undefined,
    closedIssueIds,
  };
}

/**
 * `git log <lastGreenSha>..<sha> --oneline`, through the adapter — the merges that landed
 * between the last green sweep and this red one. `null` when there is nothing to compare
 * against (no last green, no repo path) or the read failed; the body then says which.
 */
async function listCommitsSinceLastGreen(input: HealTicketReconcileInput): Promise<string[] | null> {
  if (!input.repoPath || !input.lastGreenSha || input.lastGreenSha === input.sha) return null;
  const result = await gitExec(
    ["log", "--oneline", "--no-decorate", `${input.lastGreenSha}..${input.sha}`],
    { cwd: input.repoPath, timeout: 30_000 },
  );
  if (result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * The title carries the suite COUNT, not the suite list — the list is the body's job and a
 * title that grew with it would be unreadable in a column. It changes between sweeps, which is
 * exactly why the dedupe identity is the `external_key` and never this string.
 */
export function healTicketTitle(branch: string, failedSuites: string[] | null | undefined): string {
  const n = canonicalFailedSuites(failedSuites).length;
  const what = n === 0 ? "verify failed" : `${n} failing suite${n === 1 ? "" : "s"}`;
  return `heal: base branch '${branch}' is red (${what})`;
}

/** The ticket body: failing suites + base sha + the merges since the last green + the sweep row. */
export function healTicketBody(input: HealTicketReconcileInput, commitsSinceGreen: string[] | null = null): string {
  const suites = canonicalFailedSuites(input.failedSuites);
  const lines: string[] = [
    `The nightly base-health sweep ran the project's \`verify_script\` against the base branch and it FAILED.`,
    ``,
    `- Base branch: \`${input.branch}\``,
    `- Base sha: \`${input.sha}\``,
    `- Failure signature: \`${failureSignature(input.failedSuites)}\``,
    `- Last green sweep: ${input.lastGreenSha ? `\`${input.lastGreenSha}\`` : "_none recorded_"}`,
    `- Sweep row: \`base_branch_health\` id \`${input.healthRowId ?? "(not recorded)"}\``
      + ` — \`GET /api/projects/${input.projectId}/base-branch-health\` shows the project's recent sweeps.`,
    ``,
    `## Failing suites`,
    ``,
    suites.length > 0
      ? suites.map((s) => `- \`${s}\``).join("\n")
      : `_The sweep reported no per-suite verdict (the verify command failed before or outside the suite list)._`,
    ``,
    `## Merges landed since the last green sweep`,
    ``,
    ...describeCommitsSinceGreen(input, commitsSinceGreen),
  ];
  if (input.message?.trim()) {
    lines.push(``, `## Verify output (tail)`, ``, "```", input.message.trim(), "```");
  }
  lines.push(
    ``,
    `---`,
    ``,
    `This ticket was filed by the base-health sweep because this project's red-base policy is`,
    `\`allow-file-debt-ticket\` (decision 017): a red base does NOT withhold merges here, so this`,
    `ticket is the only place the red is recorded. Diagnose the list above in ONE pass rather than`,
    `letting each branch's gate rediscover it. The sweep keeps this ticket up to date — a later red`,
    `sweep with the same failing set refreshes this body, a red with a different set files a second`,
    `ticket, and a green sweep closes them all.`,
  );
  return lines.join("\n");
}

function describeCommitsSinceGreen(input: HealTicketReconcileInput, commits: string[] | null): string[] {
  if (!input.lastGreenSha) return [`_No green sweep is recorded for this project, so there is no lower bound to list from._`];
  if (input.lastGreenSha === input.sha) return [`_This sha was already swept green; the red is not attributable to a landing._`];
  if (commits === null) return [`_Could not read \`git log ${input.lastGreenSha.slice(0, 12)}..${input.sha.slice(0, 12)}\` from the project checkout._`];
  if (commits.length === 0) return [`_No commits between the last green sweep and this sha._`];
  const shown = commits.slice(0, MAX_LISTED_COMMITS).map((c) => `- \`${c}\``);
  if (commits.length > MAX_LISTED_COMMITS) shown.push(`- _… and ${commits.length - MAX_LISTED_COMMITS} more_`);
  return [`\`git log ${input.lastGreenSha.slice(0, 12)}..${input.sha.slice(0, 12)} --oneline\` (${commits.length}):`, ``, ...shown];
}
