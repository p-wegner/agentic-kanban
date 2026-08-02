import { isTerminalStatusName } from "@agentic-kanban/shared";
import {
  DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE,
  parsePluginLoopPlan,
  pluginLoopPausedPreferenceKey,
  pluginLoopUnitKey,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginLoopDef,
  type PluginManifest,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { listPluginLoopIssues } from "../repositories/plugins.repository.js";
import { getAllPreferences, getPreference, setPreference } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { runPluginCommand } from "./plugin-exec.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";

/**
 * Board-owned converging analysis loops (plugin manifest `loops`).
 *
 * The division of labour is the whole point. The PLUGIN contributes one
 * deterministic, judgment-free command — `plan` — that prints the work units
 * still outstanding. The BOARD does everything that involves running an agent:
 * each unit becomes a normal ticket carrying the loop's skill, and the board's
 * own monitor starts those tickets within the project's WIP limit, under the
 * Strategy Bullseye's provider selection and the auth-rotation ring (so a
 * quota-exhausted profile rotates mid-loop instead of stalling the sweep), and
 * through the usual review/merge gates.
 *
 * So a loop is *resumable and observable for free*: its state is tickets on the
 * board, not a private run-log, and killing the server loses nothing.
 *
 * **Unit identity is the planner's contract.** Each created ticket stores
 * `pluginLoopUnitKey(slug, loop, unitId)` in `external_key`, and a later advance
 * skips any unit whose key already has a ticket — terminal or not. A planner that
 * wants another pass at the same subject must therefore mint a FRESH id for it
 * (e.g. `billing:round-3`); re-reporting `billing` forever would be read as "that
 * work is already ticketed" and quietly do nothing. This is deliberate: it makes
 * an infinite ticket loop impossible without the board second-guessing the plan.
 *
 * KNOWN DEBT (#201): `external_key` is documented (and rendered in the UI) as a
 * genuine external-tracker link, so this reuses that column for a private,
 * board-internal dedupe identity instead of a purpose-built one. Safe today only
 * because the key is namespace-prefixed and no loop ticket ever sets
 * `externalUrl`. If a second board feature needs the same "created by a machine,
 * dedupe on re-run" identity, give it a dedicated nullable `source_key` column
 * (or typed origin JSON) rather than growing this overload further.
 */

const PLAN_TIMEOUT_MS = 2 * 60 * 1000;

export class PluginLoopError extends Error {
  constructor(message: string, public readonly code: "NOT_FOUND" | "BAD_REQUEST" = "BAD_REQUEST") {
    super(message);
    this.name = "PluginLoopError";
  }
}

export interface LoopCreatedTicket {
  unitId: string;
  issueId: string;
  issueNumber: number | null;
  title: string;
}

export interface LoopAdvanceResult {
  loop: string;
  /** The planner's verdict: no outstanding units (or an explicit `converged: true`). */
  converged: boolean;
  note: string | null;
  /** Units the planner reported this advance. */
  planned: number;
  created: LoopCreatedTicket[];
  /** Units already ticketed by an earlier advance. */
  skippedExisting: Array<{ unitId: string; issueNumber: number | null; statusName: string }>;
  /** Units dropped because the advance hit `maxUnitsPerAdvance` — replanned next time. */
  capped: number;
  /**
   * Who will actually start the created tickets. `manual` means nobody will —
   * the tickets sit in the backlog until the user sets Start Mode or launches
   * them by hand, so the UI has to say so rather than imply the loop is running.
   */
  startMode: string;
  warnings: string[];
}

export interface LoopStatus {
  name: string;
  label: string;
  description: string | null;
  skill: string;
  /** Open (non-terminal) tickets this loop has created. */
  openTickets: number;
  /** Terminal (Done/Cancelled) tickets this loop has created. */
  closedTickets: number;
  /** True when a human has paused this loop's monitor-driven auto-advance. */
  paused: boolean;
}

export interface PluginLoopDeps {
  database: Database;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
}

export function createPluginLoopEngine(deps: PluginLoopDeps) {
  const { database, createIssue } = deps;

  function findLoop(manifest: PluginManifest, loopName: string): PluginLoopDef {
    const loop = (manifest.loops ?? []).find((l) => l.name === loopName);
    if (!loop) throw new PluginLoopError(`Loop "${loopName}" not found in plugin manifest`, "NOT_FOUND");
    return loop;
  }

  function keyPrefix(pluginSlug: string, loopName: string): string {
    // `pluginLoopUnitKey` with an empty unit id IS the prefix — derived rather
    // than re-spelled so the two can never drift apart.
    return pluginLoopUnitKey(pluginSlug, loopName, "");
  }

  /** Per-loop ticket counts for the UI, without running the (possibly slow) planner. */
  async function loopStatuses(
    manifest: PluginManifest,
    pluginSlug: string,
    projectId: string,
  ): Promise<LoopStatus[]> {
    const out: LoopStatus[] = [];
    for (const loop of manifest.loops ?? []) {
      const rows = await listPluginLoopIssues(projectId, keyPrefix(pluginSlug, loop.name), database);
      const pausedValue = await getPreference(pluginLoopPausedPreferenceKey(pluginSlug, loop.name, projectId), database);
      out.push({
        name: loop.name,
        label: loop.label ?? loop.name,
        description: loop.description ?? null,
        skill: loop.skill,
        openTickets: rows.filter((r) => !isTerminalStatusName(r.statusName)).length,
        closedTickets: rows.filter((r) => isTerminalStatusName(r.statusName)).length,
        paused: pausedValue === "true",
      });
    }
    return out;
  }

  /** Pause/resume a loop's monitor-driven auto-advance (`advanceDuePluginLoops`). */
  async function setLoopPaused(
    manifest: PluginManifest,
    pluginSlug: string,
    loopName: string,
    projectId: string,
    paused: boolean,
  ): Promise<void> {
    findLoop(manifest, loopName); // throws NOT_FOUND for an unknown loop name
    await setPreference(pluginLoopPausedPreferenceKey(pluginSlug, loopName, projectId), paused ? "true" : "false", database);
  }

  /**
   * Run one advance: plan → dedupe → create tickets. Idempotent with respect to
   * unit ids, so calling it repeatedly (a button, a monitor cycle) is safe.
   */
  async function advanceLoop(args: {
    manifest: PluginManifest;
    pluginSlug: string;
    pluginLocalPath: string;
    loopName: string;
    projectId: string;
    projectName: string;
    repoPath: string;
    leadingRepoPath: string;
    /** Resolved by the caller from the loop's (or its skill's) declared `workflow`. */
    workflowTemplateId?: string | null;
  }): Promise<LoopAdvanceResult> {
    if (!createIssue) {
      throw new PluginLoopError("Loop advance is not available on this route", "BAD_REQUEST");
    }
    const loop = findLoop(args.manifest, args.loopName);
    const vars: PluginPlaceholderVars = {
      repoPath: args.repoPath,
      leadingRepoPath: args.leadingRepoPath,
      projectName: args.projectName,
      pluginPath: args.pluginLocalPath,
    };

    const result = await runPluginCommand(substitutePluginPlaceholders(loop.plan.command, vars), {
      // A planner defaults to the plugin's own checkout — that is where its
      // scripts live; it reads the TARGET through the substituted env/args.
      cwd: loop.plan.cwd === "repo" ? args.repoPath : args.pluginLocalPath,
      env: substitutePluginEnv(loop.plan.env, vars),
      timeoutMs: PLAN_TIMEOUT_MS,
    });
    if (result.timedOut) {
      throw new PluginLoopError(`Loop "${loop.name}" plan command timed out after ${PLAN_TIMEOUT_MS / 1000}s`);
    }
    if (result.code !== 0) {
      throw new PluginLoopError(
        `Loop "${loop.name}" plan command exited ${result.code}: ${(result.stderr || result.stdout).slice(-800)}`,
      );
    }

    let plan;
    try {
      plan = parsePluginLoopPlan(result.stdout);
    } catch (err) {
      throw new PluginLoopError(err instanceof Error ? err.message : String(err));
    }

    const existing = await listPluginLoopIssues(args.projectId, keyPrefix(args.pluginSlug, loop.name), database);
    const byKey = new Map(existing.map((row) => [row.externalKey, row]));

    const created: LoopCreatedTicket[] = [];
    const skippedExisting: LoopAdvanceResult["skippedExisting"] = [];
    const warnings: string[] = [];
    const cap = loop.maxUnitsPerAdvance ?? DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE;
    let capped = 0;

    for (const unit of plan.units) {
      const key = pluginLoopUnitKey(args.pluginSlug, loop.name, unit.id);
      const prior = byKey.get(key);
      if (prior) {
        skippedExisting.push({ unitId: unit.id, issueNumber: prior.issueNumber, statusName: prior.statusName });
        continue;
      }
      if (created.length >= cap) {
        capped++;
        continue;
      }
      const issue = await createIssue({
        projectId: args.projectId,
        title: unit.title,
        description: buildUnitDescription(loop, unit.description),
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
        unitId: unit.id,
        issueId: issue.id,
        issueNumber: issue.issueNumber ?? null,
        title: unit.title,
      });
    }
    if (capped > 0) {
      warnings.push(`${capped} more unit(s) planned than this advance may create (cap ${cap}); they replan next advance.`);
    }

    const prefs = await getAllPreferences(database);
    const policy = resolveStartPolicy(new Map(prefs.map((p) => [p.key, p.value])), args.projectId);
    if (created.length > 0 && !policy.autoStartUnblocked) {
      warnings.push(
        `Start Mode is "${policy.mode}" — the board will NOT auto-start these tickets. `
        + `Set the project's Start Mode to "monitor" (Monitor view) to let the loop run hands-off.`,
      );
    }

    return {
      loop: loop.name,
      converged: plan.converged ?? plan.units.length === 0,
      note: plan.note ?? null,
      planned: plan.units.length,
      created,
      skippedExisting,
      capped,
      startMode: policy.mode,
      warnings,
    };
  }

  return { advanceLoop, loopStatuses, setLoopPaused };
}

export type PluginLoopEngine = ReturnType<typeof createPluginLoopEngine>;

/**
 * The ticket body. The planner supplies the WHAT; this adds the HOW so the
 * launched agent knows it is one unit of a converging loop and which skill it is
 * expected to run — the same brief a human would write for the ticket.
 */
function buildUnitDescription(loop: PluginLoopDef, unitDescription: string | undefined): string {
  const head = unitDescription?.trim();
  const brief = `Run the \`${loop.skill}\` skill for this unit of the "${loop.label ?? loop.name}" loop, `
    + `then commit the artifacts it produces. This ticket is one round of a converging analysis loop — `
    + `do the work for THIS unit only; the next round is planned from the state you leave behind.`;
  return head ? `${head}\n\n---\n\n${brief}` : brief;
}
