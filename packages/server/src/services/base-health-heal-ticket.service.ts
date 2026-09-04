/**
 * The base-health **heal ticket** (#1016) — land-then-heal's disclosure channel.
 *
 * Proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.B: once a project's effective
 * `redBasePolicy` is `allow-file-debt-ticket`, a red base stops withholding merges. That is only
 * honest if the red is written down somewhere a person or an agent will actually see it —
 * otherwise the posture has simply deleted the signal. So the sweep that produced the verdict
 * files ONE ticket carrying the failing-suite list, which one agent diagnoses, instead of N
 * per-branch gates re-running the same suites and each charging the innocent branch for it.
 *
 * Four rules, all of them deliberate:
 *
 *  1. **Policy is read through the resolver, never the raw pref.** `resolveRiskPosture` is the
 *     one place the per-project override's softer-only direction check runs (#1015,
 *     `red-base-policy-raw-read-ratchet.test.ts`). A project on `block` or `allow-known-debt`
 *     gets NOTHING here — not a quieter ticket, not a comment. `block` means the gate already
 *     withheld the merge and the red is visible where it happened; the heal ticket exists only
 *     for the case where nothing else will say it.
 *  2. **Log first, then write.** The log line (plan item P1.10) names the ticket that would be
 *     filed, so the behaviour is observable in a transcript even when the write half fails or
 *     is short-circuited by idempotence. It is not a dry-run mode: the write (P2.3) follows.
 *  3. **At most one OPEN heal ticket per project**, found by `external_key`
 *     (`healTicketExternalKey`), never by title — a heal title carries the failing-suite count
 *     and changes on every sweep. A second red sweep UPDATES the open ticket's body; a green
 *     sweep closes it with a comment saying which sha cleared it.
 *  4. **Top of the backlog, not outside the WIP limit.** No WIP-exemption mechanism exists in
 *     this board, and #1016 does not invent one. `priority: critical` plus a `sort_order` below
 *     every other issue in the project is the whole of "highest priority".
 *
 * A `timeout`/`unverified` sweep observed nothing about any suite, so it neither files nor
 * closes — the same contract `recordBaseSweepOutcome` applies to the outcome ledger, and for
 * the same reason: attributing a machine event to the base is a false verdict either way.
 *
 * Every failure path here is non-fatal to the caller. This is a disclosure channel hanging off
 * a health probe; a ticket that could not be written must not turn a green sweep into an error.
 */

import { HEAL_TICKET_TAG, healTicketExternalKey } from "@agentic-kanban/shared/lib/heal-ticket-key";
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { BaseBranchHealthOutcome } from "../repositories/base-branch-health.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getDoneStatusIds, updateIssueById } from "../repositories/issue-service.repository.js";
import { getMinIssueSortOrder, listIssuesByExternalKey } from "../repositories/issue/heal-ticket.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { applyIssueTag } from "./repo-tags.service.js";
import { resolveRiskPosture } from "./risk-posture.service.js";
import type { RiskPosture } from "./risk-posture.service.js";

/** Colour of the `heal` tag on first use — the board's red-ish debt colour. */
const HEAL_TAG_COLOR = "#dc2626";

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
  /** Pre-resolved posture (tests, and any caller that already resolved one). */
  posture?: RiskPosture;
  /** Injected issue creator — defaults to the real `issue.service` one. */
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  /** ISO now; PERSISTED (status-change/updated stamps), hence `now?: string`. */
  now?: string;
}

/**
 * Reconcile a project's heal ticket against one base-health sweep verdict.
 *
 * Idempotent by construction: the same verdict applied twice creates one ticket and then
 * updates it. Never throws — see the header.
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

    const externalKey = healTicketExternalKey(projectId);
    const rows = await listIssuesByExternalKey(projectId, externalKey, database);
    const open = rows.find((row) => !LEGACY_TERMINAL_STATUS_NAMES.has(row.statusName ?? ""));

    if (outcome === "green") return await closeHealTicket({ input, database, open });
    return await fileOrUpdateHealTicket({ input, database, externalKey, open });
  } catch (err) {
    // Non-fatal: this hangs off a health probe and must never fail one.
    console.warn(
      `[base-health-heal] reconcile failed for project ${projectId} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
    return { action: "noop", reason: `reconcile failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type OpenHealTicket = Awaited<ReturnType<typeof listIssuesByExternalKey>>[number] | undefined;

async function fileOrUpdateHealTicket(args: {
  input: HealTicketReconcileInput;
  database: Database;
  externalKey: string;
  open: OpenHealTicket;
}): Promise<HealTicketReconcileResult> {
  const { input, database, externalKey, open } = args;
  const title = healTicketTitle(input.branch, input.failedSuites);
  const body = healTicketBody(input);

  // Step 1 (P1.10): say what would be filed, BEFORE filing it, so the decision is legible in a
  // transcript even if the write below fails.
  console.log(
    `[base-health-heal] project ${input.projectId}: base '${input.branch}' is RED at ${shortSha(input.sha)} — `
      + `${open ? `updating heal ticket #${open.issueNumber}` : "filing heal ticket"}: "${title}" `
      + `(key ${externalKey}, tag '${HEAL_TICKET_TAG}', priority critical, top of backlog)`,
  );

  const now = input.now ?? new Date().toISOString();
  if (open) {
    // A later red sweep updates the body it already has; it never files a second ticket.
    await updateIssueById(open.id, { title, description: body, priority: "critical", updatedAt: now }, database);
    return {
      action: "updated",
      reason: `heal ticket #${open.issueNumber} updated with this sweep's failing suites`,
      issueId: open.id,
      issueNumber: open.issueNumber ?? undefined,
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
    reason: `filed heal ticket #${issue.issueNumber ?? "?"} for a red base at ${shortSha(input.sha)}`,
    issueId: issue.id,
    issueNumber: issue.issueNumber ?? undefined,
  };
}

async function closeHealTicket(args: {
  input: HealTicketReconcileInput;
  database: Database;
  open: OpenHealTicket;
}): Promise<HealTicketReconcileResult> {
  const { input, database, open } = args;
  if (!open) return { action: "noop", reason: "base is green and no heal ticket is open" };

  const now = input.now ?? new Date().toISOString();
  const doneStatusIds = await getDoneStatusIds(input.projectId, database);
  const note = `Base branch '${input.branch}' verified GREEN at ${shortSha(input.sha)} by the base-health sweep — `
    + `the red this ticket was filed for is gone.`;
  console.log(`[base-health-heal] project ${input.projectId}: closing heal ticket #${open.issueNumber} — ${note}`);

  // The comment first: if the status write fails, the ticket at least carries the reason it
  // should have closed. `author: "system"` puts it on the collapsing path, so a repeated green
  // bumps a repeat count instead of appending a row (#738).
  await insertIssueComment(
    { issueId: open.id, kind: "note", author: "system", body: note, createdAt: now },
    database,
  ).catch(() => {});

  if (doneStatusIds.length === 0) {
    // A project with no "Done" column can still be told; leaving it open is the safe half.
    return {
      action: "noop",
      reason: `heal ticket #${open.issueNumber} commented but left open — project has no 'Done' status`,
      issueId: open.id,
      issueNumber: open.issueNumber ?? undefined,
    };
  }
  await updateIssueById(open.id, { statusId: doneStatusIds[0], statusChangedAt: now, updatedAt: now }, database);
  return {
    action: "closed",
    reason: `heal ticket #${open.issueNumber} closed — base green at ${shortSha(input.sha)}`,
    issueId: open.id,
    issueNumber: open.issueNumber ?? undefined,
  };
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
  const n = failedSuites?.length ?? 0;
  const what = n === 0 ? "verify failed" : `${n} failing suite${n === 1 ? "" : "s"}`;
  return `heal: base branch '${branch}' is red (${what})`;
}

/** The ticket body: failing suites + base sha + a reference back to the sweep row. */
export function healTicketBody(input: HealTicketReconcileInput): string {
  const suites = input.failedSuites ?? [];
  const lines: string[] = [
    `The nightly base-health sweep ran the project's \`verify_script\` against the base branch and it FAILED.`,
    ``,
    `- Base branch: \`${input.branch}\``,
    `- Base sha: \`${input.sha}\``,
    `- Sweep row: \`base_branch_health\` id \`${input.healthRowId ?? "(not recorded)"}\``
      + ` — \`GET /api/projects/${input.projectId}/base-branch-health\` shows the project's recent sweeps.`,
    ``,
    `## Failing suites`,
    ``,
    suites.length > 0
      ? suites.map((s) => `- \`${s}\``).join("\n")
      : `_The sweep reported no per-suite verdict (the verify command failed before or outside the suite list)._`,
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
    `sweep rewrites this body, and a green sweep closes the ticket.`,
  );
  return lines.join("\n");
}
