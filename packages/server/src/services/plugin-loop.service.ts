import { isTerminalStatusName } from "@agentic-kanban/shared";
import {
  DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE,
  parsePluginLoopPlan,
  pluginLoopConvergedPreferenceKey,
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
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { getAllPreferences, getPreference } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { runPluginCommand, STRUCTURED_STDOUT_CAP } from "./plugin-exec.js";
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

/**
 * One in-flight advance per (project, plugin, loop) — #249.
 *
 * The dedupe is read-then-create (`listPluginLoopIssues` → `byKey.get` → `createIssue`) and
 * `issues.external_key` carries no unique index, so two overlapping advances of the SAME loop
 * both see "not ticketed yet" and both create a ticket for the same unit. The window is not
 * narrow: the planner may run for up to `PLAN_TIMEOUT_MS` (2 minutes) between the read and the
 * write. And two callers genuinely race — the monitor's `plugin-loops` phase is serialized only
 * against ITSELF (`cycleRunning`), not against `POST /api/plugins/:id/loops/:name/advance`.
 *
 * So advances of one loop are QUEUED rather than rejected: the second caller runs after the
 * first, re-reads the tickets the first created, and reports those units as `skippedExisting` —
 * which is exactly what a repeat advance is supposed to do. Module-level on purpose: the plugin
 * service is rebuilt whenever it gains a dep (`getPluginService`), so a closure-scoped map would
 * silently stop serializing at that point.
 *
 * NOT a substitute for a DB constraint. A partial unique index on `external_key` would also
 * cover a second board process against one database; this covers the real deployment (one
 * server process owns the DB) and is what makes the invariant testable.
 */
const advanceQueues = new Map<string, Promise<unknown>>();

async function withLoopAdvanceLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = advanceQueues.get(key) ?? Promise.resolve();
  // `then(run, run)`: a failed advance must not wedge the queue for the next caller.
  const attempt = prior.then(run, run);
  const tail = attempt.then(() => undefined, () => undefined);
  advanceQueues.set(key, tail);
  try {
    return await attempt;
  } finally {
    if (advanceQueues.get(key) === tail) advanceQueues.delete(key);
  }
}

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
  /**
   * True when the planner's last advance reported the JOB done (no units + `converged: true`)
   * and that verdict was persisted. The monitor stops advancing such a loop; a manual "Advance
   * now" still replans it and clears the flag if there is work again.
   */
  converged: boolean;
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
      const convergedValue = await getPreference(pluginLoopConvergedPreferenceKey(pluginSlug, loop.name, projectId), database);
      out.push({
        name: loop.name,
        label: loop.label ?? loop.name,
        description: loop.description ?? null,
        skill: loop.skill,
        openTickets: rows.filter((r) => !isTerminalStatusName(r.statusName)).length,
        closedTickets: rows.filter((r) => isTerminalStatusName(r.statusName)).length,
        paused: pausedValue === "true",
        converged: convergedValue === "true",
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
    // Through the ONE checked write, like every other plugin pref (server/CLAUDE.md): a raw
    // `setPreference` here was the last plugin writer bypassing the guard/regen path.
    await setPreferenceChecked(database, [
      { key: pluginLoopPausedPreferenceKey(pluginSlug, loopName, projectId), value: paused ? "true" : "false" },
    ]);
  }

  /**
   * Run one advance: plan → dedupe → create tickets. Idempotent with respect to
   * unit ids, so calling it repeatedly (a button, a monitor cycle) is safe — which
   * only holds because overlapping advances of one loop are serialized (#249).
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
    workflowTemplateId?: string | null;
  }): Promise<LoopAdvanceResult> {
    return withLoopAdvanceLock(
      `${args.projectId}:${args.pluginSlug}:${args.loopName}`,
      () => advanceLoopSerialized(args),
    );
  }

  async function advanceLoopSerialized(args: {
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
      // A plan is stdout read as DATA, so it must not be tail-truncated: a clipped JSON document
      // fails to parse at every offset, and the error then blames the plugin's output format
      // instead of the clipping. Measured: a 24-module plan is ~23.5 KB, well past the 16 KB
      // diagnostics tail, so this silently broke every loop on a target with many modules.
      maxStdoutChars: STRUCTURED_STDOUT_CAP,
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
      const base = err instanceof Error ? err.message : String(err);
      // Never let a truncation masquerade as a malformed plan: that misdirects the reader to the
      // plugin's JSON when the output was clipped on the way in.
      throw new PluginLoopError(
        result.stdoutTruncated
          ? `${base}\n\nNOTE: the plan command's stdout exceeded ${STRUCTURED_STDOUT_CAP} characters and its FRONT was discarded, so the payload above is a fragment. The plugin's output is probably fine — raise the cap or make the planner emit less.`
          : base,
      );
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

    // Persist the terminal verdict so the loop stops being replanned forever. Only a plan with NO
    // units and an affirmative `converged` counts: `units: [], converged: false` is the
    // documented "blocked, not done" state and must keep polling, and `converged: true` WITH
    // units is a planner still handing out work. Any advance that plans units clears the flag,
    // which is what makes a manual "Advance now" the restart path.
    const converged = plan.converged ?? plan.units.length === 0;
    const isDone = converged && plan.units.length === 0;
    await setPreferenceChecked(database, [
      {
        key: pluginLoopConvergedPreferenceKey(args.pluginSlug, loop.name, args.projectId),
        value: isDone ? "true" : "false",
      },
    ]);

    return {
      loop: loop.name,
      converged,
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
