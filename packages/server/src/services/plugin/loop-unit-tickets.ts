import {
  DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE,
  pluginLoopUnitKey,
  type PluginLoopDef,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import { listPluginLoopIssues } from "../../repositories/plugins.repository.js";
import type { CreateIssueInput, CreateIssueResult } from "../issue.service.js";
import type { LoopAdvanceResult, LoopCreatedTicket } from "../plugin-loop-types.js";
import { keyPrefix } from "./loop-identity.js";
import {
  closeResolvedUnitTickets,
  isFailedRound,
  nextRoundUnitId,
  priorRoundNote,
  type ClosedUnitTicket,
} from "./loop-unit-reconcile.js";

/**
 * Turning a plan's UNITS into tickets — where the loop's central invariant lives.
 *
 * **Unit identity is the planner's contract.** Each created ticket stores
 * `pluginLoopUnitKey(slug, loop, unitId)` in `external_key`, and a later advance skips any unit
 * whose key already has a ticket — TERMINAL OR NOT. A planner that wants another pass at the same
 * subject must therefore mint a FRESH id for it (e.g. `billing:round-3`); re-reporting `billing`
 * forever is read as "that work is already ticketed" and quietly does nothing. This is deliberate:
 * it makes an infinite ticket loop impossible without the board second-guessing the plan. Guarded
 * by `plugin-loop-invariants.test.ts`.
 *
 * The dedupe is read-then-create against a column with no unique index, so it is only sound
 * because overlapping advances of one loop are serialized — see `loop-advance-lock.ts` (#249).
 *
 * KNOWN DEBT (#201): `external_key` is documented (and rendered in the UI) as a genuine
 * external-tracker link, so this reuses that column for a private, board-internal dedupe identity
 * instead of a purpose-built one. Safe today only because the key is namespace-prefixed and no
 * loop ticket ever sets `externalUrl`. If a second board feature needs the same "created by a
 * machine, dedupe on re-run" identity, give it a dedicated nullable `source_key` column (or typed
 * origin JSON) rather than growing this overload further.
 */

export interface PlannedUnit {
  id: string;
  title: string;
  description?: string;
  artifacts?: unknown[];
}

export interface TicketedUnits {
  created: LoopCreatedTicket[];
  skippedExisting: LoopAdvanceResult["skippedExisting"];
  capped: number;
  /** Open tickets closed because their unit left the plan (`reconcileUnits` loops only, #1643). */
  closed: ClosedUnitTicket[];
  /** The cap notice, if any — phrased for the caller's `warnings` list verbatim. */
  warnings: string[];
}

export async function ticketPlannedUnits(args: {
  loop: PluginLoopDef;
  units: PlannedUnit[];
  pluginSlug: string;
  projectId: string;
  workflowTemplateId?: string | null;
  /**
   * Whether the plan is a trustworthy statement of what is still outstanding: a converged plan, or
   * one that lists units. `units: [], converged: false` is the documented "blocked, not done" state,
   * where an empty list means "unknown", and must never close anything.
   */
  planIsAuthoritative?: boolean;
  now?: string;
  createIssue: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  database: Database;
}): Promise<TicketedUnits> {
  const { loop, pluginSlug, projectId, database } = args;
  const existing = await listPluginLoopIssues(projectId, keyPrefix(pluginSlug, loop.name), database);
  // Every ticket of this loop, terminal included — the identity contract above depends on it.
  const byKey = new Map(existing.map((row) => [row.externalKey, row]));

  const created: LoopCreatedTicket[] = [];
  const skippedExisting: LoopAdvanceResult["skippedExisting"] = [];
  const warnings: string[] = [];
  const reconcile = loop.reconcileUnits === true;
  // Keys the CURRENT plan maps to (a re-opened round's key, not the planner's own) - what the close pass keeps.
  const activeKeys = new Set<string>();
  const cap = loop.maxUnitsPerAdvance ?? DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE;
  let capped = 0;

  for (const unit of args.units) {
    let unitId = unit.id;
    let key = pluginLoopUnitKey(pluginSlug, loop.name, unitId);
    let prior = byKey.get(key);
    let followUp: string | undefined;
    // #1643: walk past Done rounds the plan still reports, to the first round without a settled ticket.
    while (reconcile && prior && isFailedRound(prior)) {
      followUp = priorRoundNote(prior, unitId);
      unitId = nextRoundUnitId(unitId);
      key = pluginLoopUnitKey(pluginSlug, loop.name, unitId);
      prior = byKey.get(key);
    }
    activeKeys.add(key);
    if (prior) {
      skippedExisting.push({ unitId, issueId: prior.id, issueNumber: prior.issueNumber, statusName: prior.statusName });
      continue;
    }
    if (created.length >= cap) {
      capped++;
      continue;
    }
    const issue = await args.createIssue({
      projectId,
      title: unit.title,
      description: buildUnitDescription(loop, followUp ? `${followUp}\n\n${unit.description ?? ""}`.trim() : unit.description),
      issueType: "task",
      priority: "medium",
      externalKey: key,
      // Loop tickets are analysis work, not product changes; the loop's own
      // convergence check is the gate, so don't queue an LLM review per round.
      skipAutoReview: true,
      // …and for the same reason the loop may declare a workflow whose graph has no review
      // gate at all. `skipAutoReview` only silences the automatic reviewer; the workflow
      // template is what decides whether the ticket must pass through review to reach done.
      workflowTemplateId: args.workflowTemplateId ?? null,
    });
    created.push({
      unitId,
      issueId: issue.id,
      issueNumber: issue.issueNumber ?? null,
      title: unit.title,
      ...(unit.artifacts?.length ? { artifacts: unit.artifacts } : {}),
    } as LoopCreatedTicket);
  }
  if (capped > 0) {
    warnings.push(`${capped} more unit(s) planned than this advance may create (cap ${cap}); they replan next advance.`);
  }
  let closed: ClosedUnitTicket[] = [];
  if (reconcile && args.planIsAuthoritative) {
    const result = await closeResolvedUnitTickets({ loop, pluginSlug, projectId, existing, activeKeys, database, now: args.now });
    closed = result.closed;
    warnings.push(...result.warnings);
  }
  return { created, skippedExisting, capped, closed, warnings };
}

/**
 * The ticket body. The planner supplies the WHAT; this adds the HOW so the
 * launched agent knows it is one unit of a converging loop and which skill it is
 * expected to run — the same brief a human would write for the ticket.
 */
export function buildUnitDescription(loop: PluginLoopDef, unitDescription: string | undefined): string {
  const head = unitDescription?.trim();
  const brief = `Run the \`${loop.skill}\` skill for this unit of the "${loop.label ?? loop.name}" loop, `
    + `then commit the artifacts it produces. This ticket is one round of a converging analysis loop — `
    + `do the work for THIS unit only; the next round is planned from the state you leave behind.`;
  return head ? `${head}\n\n---\n\n${brief}` : brief;
}
