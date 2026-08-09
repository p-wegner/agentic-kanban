import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatusName } from "@agentic-kanban/shared";
import {
  DEFAULT_LOOP_MAX_UNITS_PER_ADVANCE,
  parsePluginLoopPlan,
  pluginLoopConvergedPreferenceKey,
  pluginLoopPausedPreferenceKey,
  pluginLoopUnitKey,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginLoopCheck,
  type PluginLoopDef,
  type PluginLoopGate,
  type PluginLoopProgressStep,
  type PluginManifest,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { listPluginLoopIssues, listPluginLoopUnmergedWorkspaces } from "../repositories/plugins.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import {
  insertPluginLoopEvent,
  latestPluginLoopEvent,
  listPluginLoopEvents,
  type PluginLoopEventRow,
} from "../repositories/plugin-loop-events.repository.js";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { getAllPreferences, getPreference } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { runPluginCommand, STRUCTURED_STDOUT_CAP } from "./plugin-exec.js";
import type { BoardEvents } from "./board-events.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";
import { describeLoopStartOutcome, startPlannedLoopTickets, type LoopStartOutcome } from "./plugin-loop-start.service.js";
import { describeExistingUnits } from "./plugin-loop-unit-state.js";
import { selectLoopStall, type LoopStall } from "./plugin-loop-stall.js";
import {
  beginGateRecommendationAttempt,
  endGateRecommendationAttempt,
  shouldRetryGateRecommendation,
  GATE_RECOMMENDATION_MAX_ATTEMPTS,
} from "./gate-recommendation-retry.js";

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
  /** Repo-relative artifacts the unit declared (#288). */
  artifacts?: string[];
}

export interface LoopAdvanceResult {
  loop: string;
  /** The planner's verdict: no outstanding units (or an explicit `converged: true`). */
  converged: boolean;
  note: string | null;
  /** Units the planner reported this advance. */
  planned: number;
  created: LoopCreatedTicket[];
  /**
   * Units already ticketed by an earlier advance. `issueId` is carried (#360) because the
   * post-resolve report has to resolve each of these units' REAL state, and it must not do that
   * through `issues.statusName` (measured ≥84s late, #358).
   */
  skippedExisting: Array<{ unitId: string; issueId: string; issueNumber: number | null; statusName: string }>;
  /** Units dropped because the advance hit `maxUnitsPerAdvance` — replanned next time. */
  capped: number;
  /**
   * What this advance DID about starting each ticket it created (#351/#354/#357). The surface and
   * the butler must report from this, never from a pipeline-level word like "generating": the two
   * previous reporting bugs were an over-claim ("State: generating" for a parked ticket) and a
   * silence (nothing at all after an approval).
   */
  startOutcomes: LoopStartOutcome[];
  /**
   * #357/#360 — the pre-rendered, falsifiable sentences the butler and the HTTP reply report,
   * covering EVERY unit this advance planned: the ones it created (from `startOutcomes`) AND the
   * ones it found already ticketed, each resolved from its real workspace/provisioning state.
   *
   * `startOutcomes` alone was the defect: it is built from `created` only, so when another advance
   * queued behind a gate resolve won the lock and created the unit first, this advance reported
   * `skippedExisting` with an EMPTY `startOutcomes` and the butler's fallback branch asserted that
   * nothing was planned — while the unit was 80s from a live workspace. 2 of 3 live approvals.
   */
  startNotices: string[];
  /**
   * Who will actually start the created tickets. `manual` means nobody will —
   * the tickets sit in the backlog until the user sets Start Mode or launches
   * them by hand, so the UI has to say so rather than imply the loop is running.
   */
  startMode: string;
  warnings: string[];
  /** Human gate the plan reported (#286) — null when not blocked on a person. */
  gate: PluginLoopGate | null;
  /** Declarative progress strip (#289). */
  progress: { steps: PluginLoopProgressStep[] } | null;
  /** Structured check results (#290). */
  checks: PluginLoopCheck[] | null;
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
  /** The planner's note from the most recent advance (persisted in the timeline). */
  note: string | null;
  /** When the loop last advanced (ISO), null before the first advance. */
  lastAdvanceAt: string | null;
  /** Human gate the loop is currently blocked on (#286), from the latest advance. */
  gate: PluginLoopGate | null;
  /**
   * When the CURRENT gate was first reached (ISO), from its one-time `gate-reached` event;
   * null when there is no gate (or it predates this field being recorded).
   *
   * Not the same as `lastAdvanceAt` and not interchangeable with it: the monitor re-plans a
   * gated loop every cycle, so `lastAdvanceAt` keeps moving while the human has not acted.
   * Anything that wants to say how long a decision has been waiting — the inbox, an
   * age badge, a nag — must use THIS. Reading `lastAdvanceAt` instead makes a gate that has
   * sat untouched for an hour look like it appeared moments ago (observed on a live run).
   */
  gateSince: string | null;
  /** Declarative pipeline progress (#289), from the latest advance. */
  progress: { steps: PluginLoopProgressStep[] } | null;
  /** Structured check results (#290), from the latest advance. */
  checks: PluginLoopCheck[] | null;
  /**
   * #357 — what the last advance DID about starting the tickets it planned, as pre-rendered
   * sentences. The surface needs this because the gate card VANISHES on approval and nothing took
   * its place: `note` alone ("Planned step 5/9 …") states that a plan exists and says nothing about
   * what happens next, which is indistinguishable from "nothing will ever happen".
   */
  startNotices: string[];
  /**
   * A finished-but-unlanded loop ticket (#299): the builder is done (In Review/Done) but
   * its workspace has not merged, so the planner — which reads the MAIN checkout — cannot
   * see the artifacts and every re-advance is a silent dedupe no-op. The UI renders this
   * as its own state with a one-click Merge; null when nothing is stuck.
   *
   * #336/#363 widened this to a second, differently-shaped stall — a workspace parked
   * `ready_for_merge` whose issue never left In Progress — so the value now carries a `reason`
   * and a `mergeSafe` flag. Read `mergeSafe` before offering a merge: #363's parked branch had
   * ZERO commits, and landing it would have closed the unit without its artifacts.
   */
  awaitingMerge: LoopStall | null;
  /**
   * The butler's pre-read verdict for the CURRENT gate (#309), from the latest
   * `gate-recommendation` timeline event — null when there is no gate, the
   * recommendation is for an older gate, or the feature is off.
   */
  gateRecommendation: { actionId: string; reason: string } | null;
}

export interface PluginLoopDeps {
  database: Database;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  /**
   * Injected so a freshly planned loop ticket can be STARTED in the advance path instead of
   * waiting for a monitor cycle to notice it (#351). Absent on dep-less route constructions, which
   * degrade to the old poll-dependent behaviour and say so via a `queued-no-starter` outcome.
   */
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
  /** Externally reachable board API base URL (`{{boardUrl}}` in planner command/env) —
   *  resolved by the composition root, not read from env here. */
  boardUrl: string;
  /** For the one-shot gate-reached notification (#287); absent on dep-less routes. */
  boardEvents?: BoardEvents;
}

/** What an advance persists into the timeline (`advance` event payload). */
interface AdvanceEventPayload {
  planned: number;
  created: Array<{ unitId: string; issueId: string; issueNumber: number | null; title: string; artifacts?: string[] }>;
  skippedExisting: number;
  capped: number;
  converged: boolean;
  note: string | null;
  gate: PluginLoopGate | null;
  progress: { steps: PluginLoopProgressStep[] } | null;
  checks: PluginLoopCheck[] | null;
  /**
   * #357 — pre-rendered, falsifiable sentences about what happened to the tickets this advance
   * planned. Persisted so the loop panel has something to SHOW where the gate card used to be: a
   * freshly planned unit previously left the surface with `note` alone ("Planned step 5/9 …"), a
   * statement that a plan exists with nothing about what the human should do about it.
   */
  startNotices?: string[];
}

export interface GateResolveResult {
  gateId: string;
  actionId: string;
  resolve: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  /** The re-plan run right after a successful resolve — the gate's replacement state. */
  advance: LoopAdvanceResult | null;
}

/** Re-exported from its own module (#363) — see `plugin-loop-accounting.ts` for why. */
export { isLoopUnitAccountedForByPlanner } from "./plugin-loop-accounting.js";

export function createPluginLoopEngine(deps: PluginLoopDeps) {
  const { database, createIssue, createWorkspace, boardUrl, boardEvents } = deps;

  function parseAdvancePayload(row: PluginLoopEventRow | null): AdvanceEventPayload | null {
    if (!row?.payloadJson) return null;
    try {
      return JSON.parse(row.payloadJson) as AdvanceEventPayload;
    } catch {
      return null;
    }
  }

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
      // The latest advance's persisted plan extras (gate/progress/checks/note) ARE the loop's
      // current display state — surfacing them here is what lets the panel render an approval
      // card or a stepper without re-running the (possibly slow) planner.
      const lastAdvance = await latestPluginLoopEvent(
        { pluginSlug, loopName: loop.name, projectId }, "advance", database,
      );
      const payload = parseAdvancePayload(lastAdvance);
      const unmerged = await listPluginLoopUnmergedWorkspaces(projectId, keyPrefix(pluginSlug, loop.name), database);
      const gate = payload?.gate ?? null;
      let gateRecommendation: LoopStatus["gateRecommendation"] = null;
      let gateSince: string | null = null;
      if (gate) {
        // `gate-reached` is written once per NEW gate id, so its timestamp is the gate's
        // true birth — unlike the advance row, which is restamped every monitor cycle.
        const reachedRow = await latestPluginLoopEvent(
          { pluginSlug, loopName: loop.name, projectId }, "gate-reached", database,
        );
        try {
          const reached = reachedRow?.payloadJson ? JSON.parse(reachedRow.payloadJson) as { gateId?: string } : null;
          if (reached?.gateId === gate.id) gateSince = reachedRow?.createdAt ?? null;
        } catch { /* malformed event — fall back to no age */ }
        const recoRow = await latestPluginLoopEvent(
          { pluginSlug, loopName: loop.name, projectId }, "gate-recommendation", database,
        );
        try {
          const reco = recoRow?.payloadJson ? JSON.parse(recoRow.payloadJson) as { gateId?: string; actionId?: string; reason?: string } : null;
          if (reco?.gateId === gate.id && typeof reco.actionId === "string") {
            gateRecommendation = { actionId: reco.actionId, reason: reco.reason ?? "" };
          }
        } catch { /* malformed event — no chip */ }
      }
      out.push({
        name: loop.name,
        label: loop.label ?? loop.name,
        description: loop.description ?? null,
        skill: loop.skill,
        openTickets: rows.filter((r) => !isTerminalStatusName(r.statusName)).length,
        closedTickets: rows.filter((r) => isTerminalStatusName(r.statusName)).length,
        paused: pausedValue === "true",
        converged: convergedValue === "true",
        note: payload?.note ?? null,
        lastAdvanceAt: lastAdvance?.createdAt ?? null,
        gate: payload?.gate ?? null,
        gateSince,
        progress: payload?.progress ?? null,
        checks: payload?.checks ?? null,
        // What the last advance did about starting its tickets (#357). The surface must be able to
        // say "step 5 planned, starting now" rather than leaving a blank where the gate card was.
        startNotices: payload?.startNotices ?? [],
        // Staleness filtering, ordering and CLASSIFICATION all live in `plugin-loop-stall.ts`
        // (#363): the query now returns two genuinely different stalls and they need different
        // affordances, so the surface has to be told which one it is looking at.
        awaitingMerge: selectLoopStall(unmerged, gate, payload?.progress ?? null),
        gateRecommendation,
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
    await insertPluginLoopEvent(
      { pluginSlug, loopName, projectId }, paused ? "paused" : "resumed", null, database,
    );
  }

  /**
   * Run one advance: plan → dedupe → create tickets. Idempotent with respect to
   * unit ids, so calling it repeatedly (a button, a monitor cycle) is safe — which
   * only holds because overlapping advances of one loop are serialized (#249).
   */
  async function advanceLoop(args: {
    manifest: PluginManifest;
    pluginSlug: string;
    pluginName?: string;
    /** Plugin ROW id — carried into the gate notification so receivers can deep-link (#300). */
    pluginRowId?: string | null;
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
    pluginName?: string;
    pluginRowId?: string | null;
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
      boardUrl,
      projectId: args.projectId,
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
        skippedExisting.push({ unitId: unit.id, issueId: prior.id, issueNumber: prior.issueNumber, statusName: prior.statusName });
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
        ...(unit.artifacts?.length ? { artifacts: unit.artifacts } : {}),
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
    // #351 — start what we just planned, here, instead of minting a Backlog ticket and hoping a
    // monitor phase notices it. Approval is an event; depending on a poll is what produced the
    // measured 2.5-10 minute "the board is frozen after I approved" window. `startPlannedLoopTickets`
    // owns the honesty: it returns a per-ticket outcome the caller reports verbatim, and it does NOT
    // claim the agent is running (provisioning is minutes long — see its module header).
    const startOutcomes: LoopStartOutcome[] = await startPlannedLoopTickets({
      database,
      projectId: args.projectId,
      policy,
      tickets: created.map((c) => ({ issueId: c.issueId, issueNumber: c.issueNumber })),
      createWorkspace,
    });

    // Persist the terminal verdict so the loop stops being replanned forever. Only a plan with NO
    // units and an affirmative `converged` counts: `units: [], converged: false` is the
    // documented "blocked, not done" state and must keep polling, and `converged: true` WITH
    // units is a planner still handing out work. Any advance that plans units clears the flag,
    // which is what makes a manual "Advance now" the restart path.
    const converged = plan.converged ?? plan.units.length === 0;
    const isDone = converged && plan.units.length === 0;
    const wasDone = (await getPreference(
      pluginLoopConvergedPreferenceKey(args.pluginSlug, loop.name, args.projectId), database,
    )) === "true";
    await setPreferenceChecked(database, [
      {
        key: pluginLoopConvergedPreferenceKey(args.pluginSlug, loop.name, args.projectId),
        value: isDone ? "true" : "false",
      },
    ]);

    // Timeline (#292): every advance leaves its result behind. The advance payload doubles as
    // the loop's current display state (gate/progress/checks) — see loopStatuses.
    const eventKey = { pluginSlug: args.pluginSlug, loopName: loop.name, projectId: args.projectId };
    const priorGate = parseAdvancePayload(
      await latestPluginLoopEvent(eventKey, "advance", database),
    )?.gate ?? null;
    // #357/#360 — one sentence per PLANNED unit, not per CREATED unit. The units this advance
    // found already ticketed are resolved from their real workspace/provisioning state, so the
    // report is identical whichever advance won the lock.
    const startNotices = [
      ...startOutcomes.map(describeLoopStartOutcome),
      ...await describeExistingUnits(
        skippedExisting.map((s) => ({ issueId: s.issueId, issueNumber: s.issueNumber })),
        database,
      ),
    ];
    const advancePayload: AdvanceEventPayload = {
      planned: plan.units.length,
      created,
      skippedExisting: skippedExisting.length,
      capped,
      converged,
      note: plan.note ?? null,
      gate: plan.gate ?? null,
      progress: plan.progress ?? null,
      checks: plan.checks ?? null,
      startNotices,
    };
    await insertPluginLoopEvent(eventKey, "advance", advancePayload, database);
    if (isDone && !wasDone) {
      await insertPluginLoopEvent(eventKey, "converged", { note: plan.note ?? null }, database);
    }

    // Gate-reached notification (#287): once per NEW gate id. The monitor re-plans a blocked
    // loop every cycle; comparing against the PREVIOUS advance's gate is what keeps the
    // notification from firing on every poll while the human hasn't acted yet.
    if (plan.gate) {
      // Butler concierge (#307/#309): digest turn + pre-read recommendation, both
      // best-effort and pref-gated. Deliberately NOT awaited — a gate must never
      // block or fail an advance because an LLM was slow.
      const conciergeArgs = {
        projectId: args.projectId,
        pluginRowId: args.pluginRowId ?? null,
        pluginSlug: args.pluginSlug,
        pluginName: args.pluginName ?? args.pluginSlug,
        loopName: loop.name,
        loopLabel: loop.label ?? loop.name,
        gate: plan.gate,
        checks: plan.checks ?? null,
        note: plan.note ?? null,
        repoPath: args.repoPath,
        boardUrl,
      };
      const gateId = plan.gate.id;
      if (gateId !== priorGate?.id) {
        await insertPluginLoopEvent(eventKey, "gate-reached", {
          gateId, question: plan.gate.question, artifacts: plan.gate.artifacts ?? [],
        }, database);
        boardEvents?.broadcastPluginGate(args.projectId, {
          pluginSlug: args.pluginSlug,
          pluginName: args.pluginName ?? args.pluginSlug,
          pluginId: args.pluginRowId ?? null,
          loopName: loop.name,
          loopLabel: loop.label ?? loop.name,
          gateId,
          question: plan.gate.question,
        });
        if (beginGateRecommendationAttempt(eventKey, gateId)) {
          void import("./plugin-gate-butler.service.js").then(async (m) => {
            // Recommendation FIRST (#317): its one-shot ask subscribes to the butler event
            // stream and resolves on the next `result` — if the digest turn were already in
            // flight, ITS result (prose, no JSON) would be misattributed to the ask and the
            // recommendation silently dropped. Reco completes, then the digest turn goes out.
            await m.computeGateRecommendation(conciergeArgs, database);
            await m.notifyButlerOfGate(conciergeArgs, database);
          }).catch((err) => {
            console.warn(`[plugins] gate concierge failed for ${args.pluginSlug}:${loop.name}:`, err instanceof Error ? err.message : String(err));
          }).finally(() => endGateRecommendationAttempt(eventKey, gateId));
        }
      } else {
        // #367 — the SAME gate, still open, on a later advance. The recommendation used to be a
        // one-shot on the id transition: one transient butler failure ("Not logged in", "issue
        // with the selected model", a usage limit) cost that gate its chip permanently. MEASURED:
        // linklocker held `step-2:v1` for 23 hours with a null recommendation across 350 further
        // advances, and its single attempt predated the skip-trace so it left no evidence either.
        //
        // Only the recommendation is retried — NOT the gate-reached broadcast or the butler digest
        // turn, which are genuinely once-per-gate notifications and would be spam on a re-ask.
        const decision = await shouldRetryGateRecommendation(eventKey, gateId, undefined, database);
        if (decision.retry && beginGateRecommendationAttempt(eventKey, gateId)) {
          console.log(
            `[plugins] retrying the gate recommendation for ${args.pluginSlug}:${loop.name} gate ${gateId} `
            + `(attempt ${decision.attemptNumber}/${GATE_RECOMMENDATION_MAX_ATTEMPTS}) — #367`,
          );
          void import("./plugin-gate-butler.service.js")
            .then((m) => m.computeGateRecommendation(conciergeArgs, database))
            .catch((err) => {
              console.warn(`[plugins] gate recommendation retry failed for ${args.pluginSlug}:${loop.name}:`, err instanceof Error ? err.message : String(err));
            })
            .finally(() => endGateRecommendationAttempt(eventKey, gateId));
        }
      }
    }

    return {
      loop: loop.name,
      converged,
      note: plan.note ?? null,
      planned: plan.units.length,
      created,
      skippedExisting,
      capped,
      startMode: policy.mode,
      startOutcomes,
      startNotices,
      warnings,
      gate: plan.gate ?? null,
      progress: plan.progress ?? null,
      checks: plan.checks ?? null,
    };
  }

  /** Newest-first timeline for one loop (#292). */
  async function loopEvents(pluginSlug: string, loopName: string, projectId: string, limit = 100) {
    return listPluginLoopEvents({ pluginSlug, loopName, projectId }, limit, database);
  }

  const GATE_RESOLVE_TIMEOUT_MS = 60 * 1000;

  /**
   * Apply a human's gate decision (#286): run the plugin's deterministic `resolve`
   * command with the chosen action (free text via a temp FILE, never shell
   * interpolation), then immediately re-advance the loop so the gate's
   * replacement state is in the response. Serialized on the same per-loop lock
   * as advances — a resolve mutates exactly the state the planner reads.
   */
  async function resolveGate(args: {
    manifest: PluginManifest;
    pluginSlug: string;
    pluginName?: string;
    pluginRowId?: string | null;
    pluginLocalPath: string;
    loopName: string;
    projectId: string;
    projectName: string;
    repoPath: string;
    leadingRepoPath: string;
    workflowTemplateId?: string | null;
    gateId: string;
    actionId: string;
    input?: string;
  }): Promise<GateResolveResult> {
    const loop = findLoop(args.manifest, args.loopName);
    const eventKey = { pluginSlug: args.pluginSlug, loopName: loop.name, projectId: args.projectId };

    const resolved = await withLoopAdvanceLock(
      `${args.projectId}:${args.pluginSlug}:${args.loopName}`,
      async () => {
        const gate = parseAdvancePayload(
          await latestPluginLoopEvent(eventKey, "advance", database),
        )?.gate;
        if (!gate) throw new PluginLoopError(`Loop "${loop.name}" is not blocked on a gate`, "BAD_REQUEST");
        if (gate.id !== args.gateId) {
          throw new PluginLoopError(
            `Gate "${args.gateId}" is stale — the loop's current gate is "${gate.id}". Reload and decide again.`,
            "BAD_REQUEST",
          );
        }
        const action = gate.actions.find((a) => a.id === args.actionId);
        if (!action) {
          throw new PluginLoopError(
            `Action "${args.actionId}" is not one of the gate's actions (${gate.actions.map((a) => a.id).join(", ")})`,
            "BAD_REQUEST",
          );
        }
        const text = args.input?.trim() ?? "";
        if (action.input === "text" && !text) {
          throw new PluginLoopError(`Action "${action.id}" requires a text input (e.g. revision feedback)`, "BAD_REQUEST");
        }

        const vars: PluginPlaceholderVars = {
          repoPath: args.repoPath,
          leadingRepoPath: args.leadingRepoPath,
          projectName: args.projectName,
          pluginPath: args.pluginLocalPath,
          boardUrl,
          projectId: args.projectId,
        };
        // The human's text goes through a FILE: it is arbitrary prose, and no amount of
        // quoting makes interpolating it into a shell command safe.
        const inputFile = action.input === "text"
          ? join(tmpdir(), `kanban-gate-input-${randomUUID()}.txt`)
          : null;
        if (inputFile) writeFileSync(inputFile, text, "utf8");
        try {
          const result = await runPluginCommand(substitutePluginPlaceholders(gate.resolve.command, vars), {
            cwd: gate.resolve.cwd === "repo" ? args.repoPath : args.pluginLocalPath,
            env: {
              ...substitutePluginEnv(gate.resolve.env, vars),
              GATE_ID: gate.id,
              GATE_ACTION: action.id,
              ...(inputFile ? { GATE_INPUT_FILE: inputFile } : {}),
            },
            timeoutMs: GATE_RESOLVE_TIMEOUT_MS,
          });
          if (result.timedOut || result.code !== 0) {
            throw new PluginLoopError(
              `Gate resolve command ${result.timedOut ? "timed out" : `exited ${result.code}`}: `
              + `${(result.stderr || result.stdout).slice(-800)}`,
            );
          }
          await insertPluginLoopEvent(eventKey, "gate-resolved", {
            gateId: gate.id,
            actionId: action.id,
            actionLabel: action.label,
            // An excerpt is enough for the audit trail; the full text went to the plugin.
            input: text ? text.slice(0, 500) : null,
          }, database);
          // #306 — mirror the decision onto the loop TICKET's own history, where a human
          // browsing the board actually looks; the loop timeline alone is a hidden pane.
          // Best-effort: the newest ticket of this loop is the unit the gate belongs to
          // under strict-linear loops; for fan-out loops it is still the round's anchor.
          try {
            const ticketRows = await listPluginLoopIssues(args.projectId, keyPrefix(args.pluginSlug, loop.name), database);
            const newest = ticketRows.sort((a, b) => (b.issueNumber ?? 0) - (a.issueNumber ?? 0))[0];
            if (newest) {
              await insertIssueComment({
                issueId: newest.id,
                workspaceId: null,
                kind: "gate-decision",
                author: "user",
                body: `Gate ${gate.id}: ${action.label}${text ? ` — ${text.slice(0, 500)}` : ""}`,
                payload: { gateId: gate.id, actionId: action.id, loop: loop.name, pluginSlug: args.pluginSlug },
                createdAt: new Date().toISOString(),
              }, database);
            }
          } catch (err) {
            console.warn(`[plugins] failed to record gate decision comment:`, err instanceof Error ? err.message : String(err));
          }
          return { gate, action, result };
        } finally {
          if (inputFile) {
            try { unlinkSync(inputFile); } catch { /* best effort */ }
          }
        }
      },
    );

    // Re-plan outside the lock body above (advanceLoop takes the same lock itself).
    let advance: LoopAdvanceResult | null = null;
    try {
      advance = await advanceLoop({ ...args });
    } catch (err) {
      // The resolve itself succeeded — a re-plan failure must not mask that.
      console.warn(`[plugins] post-resolve advance of ${args.pluginSlug}:${loop.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // #357 — say something. Until now the butler produced the gate digest and the recommendation
    // BEFORE the decision and then went silent at the one moment the user is guaranteed to be
    // looking: the gate card disappears on approval and nothing replaces it. The user's report was
    // "i approved but nothing happens, the butler didnt say anything/ask".
    //
    // The sentences are pre-rendered from what the advance actually DID (`startOutcomes`), never
    // from `issues.statusName` — that field is measured ≥84s late (#358), so guidance built on it
    // would inherit the bug it is meant to fix. Fire-and-forget: a gate resolve must never fail or
    // block because an LLM was slow.
    {
      // #360 — the union of created AND already-ticketed units, each resolved from its real
      // state. Reading `startOutcomes` here (created only) is what made the message false on 2 of
      // 3 approvals: the happy path was already right, and only this branch fell through to the
      // butler's "nothing was planned" fallback.
      const startSentences = advance?.startNotices ?? [];
      void import("./plugin-gate-butler.service.js").then((m) => m.notifyButlerOfGateResolution({
        projectId: args.projectId,
        pluginName: args.pluginName ?? args.pluginSlug,
        loopLabel: loop.label ?? loop.name,
        gateId: resolved.gate.id,
        actionLabel: resolved.action.label,
        startSentences,
        note: advance?.note ?? null,
        converged: advance?.converged ?? false,
      }, database)).catch((err) => {
        console.warn(`[plugins] gate-resolution butler turn failed for ${args.pluginSlug}:${loop.name}:`, err instanceof Error ? err.message : String(err));
      });
    }
    return {
      gateId: resolved.gate.id,
      actionId: resolved.action.id,
      resolve: {
        code: resolved.result.code,
        stdout: resolved.result.stdout.slice(-2000),
        stderr: resolved.result.stderr.slice(-2000),
        timedOut: resolved.result.timedOut,
      },
      advance,
    };
  }

  return { advanceLoop, loopStatuses, setLoopPaused, loopEvents, resolveGate };
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
