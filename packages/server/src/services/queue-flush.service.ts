/**
 * The queue flush, wired (#1463; decision 020 — the follow-up `queue-flush-trigger.service.ts`'s
 * header says was left undone). The decision layer already existed (`checkQueueFlushRails`,
 * `runFlushTrain`'s pieces, `flush-state.ts`, `resolveHealTarget`); this is the orchestrator that
 * the `POST /api/projects/:id/queue/flush` route, `pnpm cli -- queue flush` and the auto tick share,
 * so the three can never disagree about a refusal.
 *
 *  1. {@link QueueFlushService.runFlush}: rails -> every ready branch as ONE train in flush mode
 *     (`executeQueue(..., { flush })`) -> on landing: the `flush/<date>-N` tag, a record in
 *     `.kanban/flush-state.json` (state `flushed`), a comment on every member ticket.
 *  2. {@link QueueFlushService.reconcileHeal}: moves the record `flushed -> sweeping -> red ->
 *     healing -> healed -> merged-back` off the base-branch health rows (master target: the
 *     sweep is the ordinary base probe, requested on demand; heal tickets are filed per failure
 *     signature by the #1233 machinery). For an `rc` target the rc cut is `pnpm promote`'s job —
 *     the record waits in `flushed` until a candidate containing the landing exists.
 *  3. {@link QueueFlushService.evaluateAuto}: the tick's call when `queue_flush_<id>=auto`.
 *
 * A project gets ONE flush at a time (in-process guard) — a double click is a refusal, not a
 * second train; the train layer's own `already_in_flight` check covers a cross-process race.
 */
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import type { QueuePressureSummary } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { getWorkspaceById } from "../repositories/workspace-reads.repository.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getLatestBaseBranchHealth, getLastGreenBaseBranchHealth, decodeFailedSuites, isBaseHealthAnswer } from "../repositories/base-branch-health.repository.js";
import { requireProject } from "./require-project.js";
import { resolveRiskPosture } from "./risk-posture.service.js";
import { currentRcCandidate, readRcState, resolveStableCheckoutFor } from "./rc-state.js";
import { resolveHealTarget, type HealTarget } from "./heal-target.service.js";
import {
  appendFlushRecord, applyFlushTransition, isTerminalFlushState, readFlushState, sortFlushes, updateFlushRecord,
  type FlushRecord,
} from "./flush-state.js";
import {
  checkQueueFlushRails, evaluateQueueFlushThresholds, formatQueueFlushDryRun, parseQueueFlushDailyCap,
  parseQueueFlushMode, parseQueueFlushThresholds, queueFlushDailyCapPrefKey, queueFlushPrefKey,
  queueFlushThresholdsPrefKey, supersedesInFlight, type QueueFlushMode,
} from "./queue-flush-trigger.service.js";
import { formatFlushMessage } from "./merge-train-flush.js";
import { DEFAULT_FLUSH_GATE_SCRIPT, type FlushLanding, type FlushRunSpec } from "./merge-train-flush-run.js";
import { getQueuePressure, readQueuePressureMembers } from "./queue-pressure.service.js";
import { listOpenHealTickets, reconcileBaseHealthHealTicket } from "./base-health-heal-ticket.service.js";
import { requestBaseBranchReprobe } from "./base-branch-health-reprobe.service.js";
import * as gitService from "./git.service.js";
import type { MergeQueueEvent } from "./merge-queue.service.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const queueFlushGatePref = projectPref("queue_flush_gate");

export interface QueueFlushDeps {
  database: Database;
  /** The merge queue's executor — injected so the service never builds a session manager itself. */
  executeQueue: (workspaceIds: string[], opts: { flush: FlushRunSpec }) => AsyncGenerator<MergeQueueEvent>;
  /** The on-demand base sweep; defaults to the real, due-checked one. */
  requestSweep?: (projectId: string, database: Database, opts?: { branch?: string | null }) => Promise<unknown>;
  /** Where a flush's lifecycle file lives; defaults to the project's stable checkout. */
  stableCheckoutFor?: (repoPath: string) => string;
}

export interface FlushPlan {
  projectId: string;
  mode: QueueFlushMode;
  healTarget: HealTarget;
  refusal: string | null;
  members: Array<{ workspaceId: string; issueNumber: number | null }>;
  /** `previous flush is red, will be abandoned and its heal tickets carried over`. */
  supersedes: FlushRecord | null;
  dryRunText: string;
}

export interface FlushOutcome {
  /** True when a train ran and landed at least one branch. */
  ok: boolean;
  refused?: string;
  dryRun?: boolean;
  plan: FlushPlan;
  flush?: FlushRecord;
  merged: string[];
  failed: string[];
  skipped: string[];
  message?: string;
}

export interface AutoEvaluation {
  fired: boolean;
  reason: string;
  outcome?: FlushOutcome;
}

export function createQueueFlushService(deps: QueueFlushDeps) {
  const { database, executeQueue } = deps;
  const stableOf = deps.stableCheckoutFor ?? ((repoPath: string) => resolveStableCheckoutFor(repoPath));
  const requestSweep = deps.requestSweep
    ?? ((projectId: string, db: Database, opts?: { branch?: string | null }) =>
      requestBaseBranchReprobe(projectId, db, undefined, Date.now(), { ignoreRecency: true, branch: opts?.branch ?? null }));
  const running = new Set<string>();

  async function plan(projectId: string, now: string): Promise<{ plan: FlushPlan; repoPath: string; prefMap: Map<string, string> }> {
    const project = await requireProject(projectId, database);
    const prefMap = toPrefMap(await getAllPreferences(database));
    const mode = parseQueueFlushMode(prefMap.get(queueFlushPrefKey(projectId)));
    const posture = resolveRiskPosture(prefMap, projectId);
    const healTarget = resolveHealTarget(prefMap, projectId);
    const stable = stableOf(project.repoPath);
    const flushes = sortFlushes(readFlushState(stable).flushes);
    const rcSweeping = currentRcCandidate(readRcState(stable))?.state === "sweeping";
    const members = (await readQueuePressureMembers(projectId, database)).map((m) => ({ workspaceId: m.workspaceId, issueNumber: m.issueNumber }));

    let refusal = checkQueueFlushRails({
      mode, posture: posture.level, flushTimestamps: flushes.map((f) => f.at),
      dailyCap: parseQueueFlushDailyCap(prefMap.get(queueFlushDailyCapPrefKey(projectId))), now,
      promotionSweeping: rcSweeping,
    })?.reason ?? null;
    if (!refusal && running.has(projectId)) refusal = "a flush is already running for this project";
    if (!refusal && members.length === 0) refusal = "nothing is ready for merge — the queue is empty";
    // Decision 020 item 5: only a still-RED flush is superseded. One that is mid-sweep is not.
    const latest = flushes[0] ?? null;
    if (!refusal && latest && (latest.state === "sweeping")) refusal = `flush ${latest.id} is still being swept — wait for its verdict`;
    const supersedes = latest && supersedesInFlight(latest.state) ? latest : null;

    const dryRunText = formatQueueFlushDryRun({
      refusal: refusal ? { reason: refusal } : null,
      memberBranches: members.map((m) => (m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId)),
      healTarget,
    }) + (supersedes && !refusal ? ` (supersedes red flush ${supersedes.id})` : "");
    return { plan: { projectId, mode, healTarget, refusal, members, supersedes, dryRunText }, repoPath: project.repoPath, prefMap };
  }

  async function runFlush(
    projectId: string,
    opts: { triggeredBy: "manual" | "cli" | "auto"; dryRun?: boolean; now?: string } = { triggeredBy: "manual" },
  ): Promise<FlushOutcome> {
    const now = opts.now ?? new Date().toISOString();
    const { plan: p, repoPath, prefMap } = await plan(projectId, now);
    const empty = { merged: [] as string[], failed: [] as string[], skipped: [] as string[] };
    if (p.refusal) return { ok: false, refused: p.refusal, plan: p, ...empty };
    if (opts.dryRun) return { ok: false, dryRun: true, plan: p, ...empty };

    // Re-checked with no await between the check and the add, so two racing starts cannot both pass.
    if (running.has(projectId)) return { ok: false, refused: "a flush is already running for this project", plan: p, ...empty };
    running.add(projectId);
    const stable = stableOf(repoPath);
    let flush: FlushRecord | undefined;
    const spec: FlushRunSpec = {
      gateScript: prefMap.get(queueFlushGatePref.key(projectId))?.trim() || DEFAULT_FLUSH_GATE_SCRIPT,
      now,
      onFinished: async (landing) => {
        flush = await recordLanding({ projectId, stable, landing, healTarget: p.healTarget, triggeredBy: opts.triggeredBy, now, supersedes: p.supersedes });
      },
    };
    const outcome: FlushOutcome = { ok: false, plan: p, ...empty };
    try {
      for await (const ev of executeQueue(p.members.map((m) => m.workspaceId), { flush: spec })) {
        if (ev.type === "done") {
          outcome.merged = ev.merged; outcome.failed = ev.failed; outcome.skipped = ev.skipped;
        } else if (ev.type === "error" && !outcome.message) {
          outcome.message = ev.error;
        }
      }
    } finally {
      running.delete(projectId);
    }
    outcome.flush = flush;
    outcome.ok = outcome.merged.length > 0 && Boolean(flush);
    if (flush) {
      outcome.message = formatFlushMessage({ landedCount: outcome.merged.length, healTarget: p.healTarget });
      // Start the sweep right away; failures here are the next tick's job, never the flush's.
      await reconcileHeal(projectId, { now }).catch((err) => console.warn(`[queue-flush] first heal pass failed (non-fatal): ${errorMessage(err)}`));
    } else if (!outcome.message) {
      outcome.message = "the flush train landed nothing (gate red, or every member was sided)";
    }
    return outcome;
  }

  async function recordLanding(args: {
    projectId: string; stable: string; landing: FlushLanding; healTarget: HealTarget;
    triggeredBy: "manual" | "cli" | "auto"; now: string; supersedes: FlushRecord | null;
  }): Promise<FlushRecord | undefined> {
    const { landing, healTarget, now } = args;
    const { run, tag } = landing;
    if (!tag || run.landed.length === 0) return undefined;
    let carriedTickets: number[] = [];
    if (args.supersedes) {
      // Superseding a red flush: abandon it and carry its open heal tickets onto this one.
      carriedTickets = args.supersedes.openHealTickets;
      updateFlushRecord(args.stable, args.supersedes.id, (r) => applyFlushTransition(r, "abandoned", { now }).record);
    }
    const record: FlushRecord = {
      id: tag, at: now, triggeredBy: args.triggeredBy,
      memberIssueNumbers: run.landed.map((m) => m.issueNumber).filter((n): n is number => typeof n === "number"),
      memberBranches: run.landed.map((m) => m.branch),
      landingSha: run.mergeSha ?? null, tag,
      sweepTarget: healTarget === "rc" ? "rc" : "master",
      state: "flushed", openHealTickets: carriedTickets, updatedAt: now,
    };
    appendFlushRecord(args.stable, record);
    const body = `Landed in queue flush ${tag} (${run.landed.length} branch(es), landing ${run.mergeSha?.slice(0, 8)}): `
      + `gate = arch + typecheck only; the full suite is deferred to the ${healTarget} sweep — a red will be filed as a heal ticket.`;
    for (const m of run.landed) {
      const ws = await getWorkspaceById(m.workspaceId, database).catch(() => undefined);
      if (!ws) continue;
      await insertIssueComment({
        issueId: ws.issueId, workspaceId: m.workspaceId, kind: "merge-attempt", author: "system", body,
        payload: { eventType: "queue-flush", flushId: tag, healTarget }, createdAt: now,
      }, database).catch((err) => console.warn(`[queue-flush] member comment failed for ${m.workspaceId} (non-fatal): ${errorMessage(err)}`));
    }
    return record;
  }

  /** Advance every non-terminal flush of the project one verdict at a time. Never throws. */
  async function reconcileHeal(projectId: string, opts: { now?: string } = {}): Promise<FlushRecord[]> {
    const now = opts.now ?? new Date().toISOString();
    const project = await requireProject(projectId, database);
    const stable = stableOf(project.repoPath);
    const moved: FlushRecord[] = [];
    for (const rec of readFlushState(stable).flushes) {
      if (isTerminalFlushState(rec.state)) continue;
      try {
        const next = await advance(projectId, project.repoPath, stable, rec, now);
        if (next) moved.push(next);
      } catch (err) {
        console.warn(`[queue-flush] heal pass for ${rec.id} failed (non-fatal): ${errorMessage(err)}`);
      }
    }
    return moved;
  }

  async function advance(projectId: string, repoPath: string, stable: string, rec: FlushRecord, now: string): Promise<FlushRecord | null> {
    const patchTo = (to: FlushRecord["state"], patch: Partial<FlushRecord> = {}) =>
      updateFlushRecord(stable, rec.id, (r) => applyFlushTransition({ ...r, ...patch }, to, { now }).record);
    const onRc = rec.sweepTarget !== "master";
    const rcBranch = onRc ? await rcContaining(stable, repoPath, rec) : null;
    // The cadence has not cut a candidate holding this landing yet: nothing to sweep.
    if (onRc && !rcBranch) return null;

    if (rec.state === "flushed") {
      await requestSweep(projectId, database, { branch: rcBranch });
      return patchTo("sweeping");
    }
    const row = await getLatestBaseBranchHealth(projectId, database, rcBranch ? { branch: rcBranch } : undefined);
    const verdict = row && isBaseHealthAnswer(row.outcome) && row.createdAt >= rec.at && rec.landingSha
      && (row.sha === rec.landingSha || await gitService.isAncestor(repoPath, rec.landingSha, row.sha).catch(() => false))
      ? row : null;

    if (rec.state === "sweeping" || rec.state === "red") {
      if (!verdict) return null;
      if (verdict.outcome === "green") return rec.state === "red" ? null : patchTo("healed");
      // master: file per-signature heal tickets now; rc: the rc probe hook (#1239) already did.
      const tickets = onRc ? await openRcTicketNumbers(projectId) : await fileHealTickets(projectId, repoPath, rec, verdict, now);
      if (rec.state === "sweeping") patchTo("red", { openHealTickets: tickets });
      return tickets.length > 0 ? patchTo("healing", { openHealTickets: tickets }) : readFlushState(stable).flushes.find((f) => f.id === rec.id) ?? null;
    }
    if (rec.state === "healing") {
      // Healed when a later sweep is green (it closes the tickets itself) or none of ours is open.
      const open = onRc ? await openRcTicketNumbers(projectId) : await openBaseTicketNumbers(projectId);
      const stillOpen = rec.openHealTickets.filter((n) => open.includes(n));
      if (verdict?.outcome === "green" || stillOpen.length === 0) return patchTo("healed", { openHealTickets: [] });
      if (stillOpen.length === rec.openHealTickets.length) return null;
      return updateFlushRecord(stable, rec.id, (r) => ({ ...r, openHealTickets: stillOpen, updatedAt: now }));
    }
    // rc target only: master collapses `healed -> merged-back` inside `applyFlushTransition`.
    if (rec.state === "healed") return patchTo("merged-back");
    return null;
  }

  async function openBaseTicketNumbers(projectId: string): Promise<number[]> {
    return (await listOpenHealTickets(projectId, database, { lane: "base" })).map((t) => t.issueNumber).filter((n): n is number => typeof n === "number");
  }
  async function openRcTicketNumbers(projectId: string): Promise<number[]> {
    return (await listOpenHealTickets(projectId, database, { lane: "all" })).map((t) => t.issueNumber).filter((n): n is number => typeof n === "number");
  }

  async function rcContaining(stable: string, repoPath: string, rec: FlushRecord): Promise<string | null> {
    const cand = currentRcCandidate(readRcState(stable));
    if (!cand || !rec.landingSha) return null;
    return (await gitService.isAncestor(repoPath, rec.landingSha, cand.branch).catch(() => false)) ? cand.branch : null;
  }

  async function fileHealTickets(
    projectId: string, repoPath: string, rec: FlushRecord,
    row: NonNullable<Awaited<ReturnType<typeof getLatestBaseBranchHealth>>>, now: string,
  ): Promise<number[]> {
    const prefMap = toPrefMap(await getAllPreferences(database));
    const posture = resolveRiskPosture(prefMap, projectId);
    const lastGreen = await getLastGreenBaseBranchHealth(projectId, database).catch(() => null);
    // A flush's whole point is that the red is healed by ticket: file regardless of the rung's red-base policy.
    await reconcileBaseHealthHealTicket({
      projectId, outcome: "red", sha: row.sha, branch: row.branch,
      failedSuites: decodeFailedSuites(row.failedSuites), healthRowId: row.id, message: row.message ?? undefined,
      repoPath, lastGreenSha: lastGreen?.sha ?? null, now,
      posture: { ...posture, redBasePolicy: "allow-file-debt-ticket" },
    }, database);
    const open = await listOpenHealTickets(projectId, database, { lane: "base" });
    for (const t of open) {
      await insertIssueComment({
        issueId: t.id, kind: "note", author: "system", createdAt: now,
        body: `Filed for queue flush ${rec.tag}: the post-flush ${rec.sweepTarget} sweep ran the full suite and it is red.`,
      }, database).catch(() => undefined);
    }
    return openBaseTicketNumbers(projectId);
  }

  /** The tick's entry (decision 020 item 5): evaluate the thresholds and fire the same path a click does. */
  async function evaluateAuto(projectId: string, opts: { now?: string; nowMs?: number } = {}): Promise<AutoEvaluation> {
    const now = opts.now ?? new Date().toISOString();
    const project = await requireProject(projectId, database);
    const prefMap = toPrefMap(await getAllPreferences(database));
    if (parseQueueFlushMode(prefMap.get(queueFlushPrefKey(projectId))) !== "auto") return { fired: false, reason: "queue_flush is not auto" };
    const summary: QueuePressureSummary = await getQueuePressure(projectId, project.repoPath, database, opts.nowMs ?? Date.parse(now));
    const verdict = evaluateQueueFlushThresholds(summary, parseQueueFlushThresholds(prefMap.get(queueFlushThresholdsPrefKey(projectId))));
    if (!verdict.met) return { fired: false, reason: "thresholds not met" };
    const outcome = await runFlush(projectId, { triggeredBy: "auto", now });
    return { fired: !outcome.refused, reason: outcome.refused ?? `thresholds met (${verdict.metBy.join(", ")})`, outcome };
  }

  /**
   * The route's door: rails + dry-run answer immediately; a real flush runs DETACHED (a train is
   * minutes to hours — far past any HTTP client's header timeout) and `done` settles with its
   * outcome for callers (tests, `wait`) that do want to block on it.
   */
  async function start(
    projectId: string,
    opts: { triggeredBy: "manual" | "cli" | "auto"; dryRun?: boolean; now?: string },
  ): Promise<{ started: boolean; plan: FlushPlan; refused?: string; dryRun?: boolean; done?: Promise<FlushOutcome> }> {
    const { plan: p } = await plan(projectId, opts.now ?? new Date().toISOString());
    if (p.refusal) return { started: false, plan: p, refused: p.refusal };
    if (opts.dryRun) return { started: false, plan: p, dryRun: true };
    const done = runFlush(projectId, opts);
    done.catch((err) => console.warn(`[queue-flush] flush for project ${projectId} failed: ${errorMessage(err)}`));
    return { started: true, plan: p, done };
  }

  return { start, plan: async (projectId: string, now = new Date().toISOString()) => (await plan(projectId, now)).plan, runFlush, reconcileHeal, evaluateAuto };
}

export type QueueFlushService = ReturnType<typeof createQueueFlushService>;
