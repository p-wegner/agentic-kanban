/**
 * Heal a ready workspace whose branch conflicts with the BASE (#1584).
 *
 * Observed 2026-10-17: after train 04 landed, ready members (#1569, #1572, #1562) conflicted with
 * master itself, not with another member. The console showed `merge conflict: <files>` and nothing
 * acted on it, so the train dropped them again. A conflict with the base is no member's fault and
 * not worth a human, so each pass, for every idle ready workspace that does conflict:
 *
 *  1. rebase it with the board's own update-base action (a clean rebase ends it);
 *  2. a conflict only in `CONTINUE.md` (append-style notes) is resolved mechanically, keeping both
 *     sides, with no builder turn;
 *  3. any other conflict gives the builder ONE fix turn naming the conflicting files and the base
 *     commits that touched them (a `/turn` to a live session, a relaunch otherwise). The workspace
 *     leaves the ready set meanwhile; the builder's exit (review, review-exit gate) re-arms it.
 *
 * One turn per branch tip: an unchanged tip is never asked twice, and after `HEAL_MAX_TURNS` turns
 * the workspace gets a merge hold (needs attention) instead. Workspaces that are mid-merge, held,
 * running a session, or members of a live train for their project are left alone.
 */
import type { Database } from "../db/index.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { clearWorkspaceReadyForMerge } from "../repositories/workspace-merge-prevalidation.repository.js";
import { setWorkspaceReadyForMerge } from "../repositories/workspace-crud.repository.js";
import type { ReadyHealCandidateRow } from "../repositories/merge-queue.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { isKeepBothOnly } from "../services/base-conflict-keep-both.js";
import { holdAfterSendBackCap } from "../services/merge-train-send-back.js";

/** The same workspace is probed at most once per window, whatever the probe found. */
export const HEAL_COOLDOWN_MS = 4 * 60_000;
/** Builder turns per workspace before it gets a merge hold instead. */
export const HEAL_MAX_TURNS = 2;

const lastProbeMs = new Map<string, number>();
const turnsSent = new Map<string, { count: number; lastTipSha: string | null }>();

export type RebaseOutcome = { success: boolean; conflictingFiles?: string[]; error?: string };

export interface ReadyBaseConflictHealDeps {
  database: Database;
  listCandidates: () => Promise<ReadyHealCandidateRow[]>;
  /** Repo + base for a workspace, or null when it cannot be resolved. */
  resolveRepo: (c: ReadyHealCandidateRow) => Promise<{ repoPath: string; baseBranch: string } | null>;
  /** Anything that makes the workspace not ours to touch right now (merge hold, running session/job, live train). */
  isBusy: (c: ReadyHealCandidateRow) => Promise<boolean>;
  /** Read-only merge-tree probe: does the branch conflict with the base? */
  detectConflicts: (repoPath: string, branch: string, baseBranch: string) => Promise<{ hasConflicts: boolean; files: string[] }>;
  /** The board's update-base action in rebase mode. Throws on refusal. */
  rebase: (workspaceId: string) => Promise<RebaseOutcome>;
  /** Rebase resolving keep-both files mechanically; false = nothing changed. */
  rebaseKeepBoth: (workingDir: string, baseBranch: string) => Promise<boolean>;
  /** Short `sha subject` lines of base commits (not on the branch) that touched `files`. */
  baseCommitsTouching: (repoPath: string, branch: string, baseBranch: string, files: string[]) => Promise<string[]>;
  branchTip: (repoPath: string, branch: string) => Promise<string | null>;
  hasLiveSession: (workspaceId: string) => Promise<boolean>;
  sendTurn: (workspaceId: string, content: string) => Promise<unknown>;
  relaunch: (workspaceId: string, prompt: string) => Promise<unknown>;
  nowMs?: number;
  /** ISO, persisted on the comment/hold. */
  now?: string;
}

export interface ReadyBaseConflictHealReport {
  scanned: number;
  rebased: string[];
  keptBoth: string[];
  turned: string[];
  held: string[];
  skipped: number;
}

/** DECISION (pure): is this the moment to probe this workspace? */
export function decideHealProbe(workspaceId: string, nowMs: number): { probe: true } | { probe: false; reason: string } {
  const last = lastProbeMs.get(workspaceId);
  if (last !== undefined && nowMs - last < HEAL_COOLDOWN_MS) return { probe: false, reason: "probed recently" };
  return { probe: true };
}

/** The one fix turn: names the files and the base commits that caused them. */
export function formatBaseConflictFixTurn(args: { branch: string; baseBranch: string; files: string[]; baseCommits: string[] }): string {
  const files = args.files.length > 0 ? args.files.map((f) => `- ${f}`).join("\n") : "(git did not name them)";
  const commits = args.baseCommits.length > 0
    ? `\n\nBase commits that touched them:\n${args.baseCommits.map((c) => `- ${c}`).join("\n")}`
    : "";
  return (
    `This branch (${args.branch}) is ready for merge but no longer merges cleanly onto the local '${args.baseBranch}', ` +
    `which moved since you finished. The board tried to rebase it and the rebase conflicts.\n\n` +
    `Conflicting files:\n${files}${commits}\n\n` +
    `1. Rebase onto the LOCAL base: \`git rebase ${args.baseBranch}\` (not origin/${args.baseBranch}).\n` +
    `2. Resolve each conflict keeping the intent of BOTH sides: what '${args.baseBranch}' changed there is already ` +
    `merged work and must survive, and so must this ticket's change.\n` +
    `3. \`git add\` the resolved files and \`git rebase --continue\` until the rebase is done.\n` +
    `4. Run the tests that cover the files you touched (and typecheck), and fix what the rebase broke.\n` +
    `5. Commit. Do not push and do not merge: when this session ends the board reviews the branch and puts it back ` +
    `in the merge queue.`
  );
}

export async function reconcileReadyBaseConflicts(deps: ReadyBaseConflictHealDeps): Promise<ReadyBaseConflictHealReport> {
  const nowMs = deps.nowMs ?? Date.now();
  const now = deps.now ?? new Date(nowMs).toISOString();
  const report: ReadyBaseConflictHealReport = { scanned: 0, rebased: [], keptBoth: [], turned: [], held: [], skipped: 0 };
  for (const c of await deps.listCandidates()) {
    report.scanned++;
    const who = `#${c.issueNumber ?? "?"} (${c.workspaceId})`;
    try {
      if (!decideHealProbe(c.workspaceId, nowMs).probe || (await deps.isBusy(c))) { report.skipped++; continue; }
      const repo = await deps.resolveRepo(c);
      if (!repo) { report.skipped++; continue; }
      const probe = await deps.detectConflicts(repo.repoPath, c.branch, repo.baseBranch);
      if (!probe.hasConflicts) { report.skipped++; continue; }
      lastProbeMs.set(c.workspaceId, nowMs);

      const rebase = await deps.rebase(c.workspaceId);
      if (rebase.success) {
        report.rebased.push(c.workspaceId);
        console.log(`[ready-base-conflict] ${who} conflicted with ${repo.baseBranch} (${probe.files.join(", ")}) - rebased by the board`);
        continue;
      }
      const files = rebase.conflictingFiles?.length ? rebase.conflictingFiles : probe.files;
      if (isKeepBothOnly(files) && (await deps.rebaseKeepBoth(c.workingDir, repo.baseBranch))) {
        report.keptBoth.push(c.workspaceId);
        console.log(`[ready-base-conflict] ${who} conflicted only in ${files.join(", ")} - resolved mechanically, kept both sides`);
        continue;
      }

      const tip = await deps.branchTip(repo.repoPath, c.branch);
      const sent = turnsSent.get(c.workspaceId) ?? { count: 0, lastTipSha: null };
      if (tip !== null && sent.lastTipSha === tip) { report.skipped++; continue; } // already asked about this exact tip
      const reason = `Merge conflict in: ${files.join(", ")}`;
      if (sent.count >= HEAL_MAX_TURNS) {
        await holdAfterSendBackCap({ workspaceId: c.workspaceId, drops: sent.count, reason, now, database: deps.database });
        report.held.push(c.workspaceId);
        console.warn(`[ready-base-conflict] ${who} still conflicts after ${sent.count} fix turn(s) - merge hold placed (needs attention): ${files.join(", ")}`);
        continue;
      }
      const baseCommits = await deps.baseCommitsTouching(repo.repoPath, c.branch, repo.baseBranch, files).catch(() => []);
      const prompt = formatBaseConflictFixTurn({ branch: c.branch, baseBranch: repo.baseBranch, files, baseCommits });
      await clearWorkspaceReadyForMerge(c.workspaceId, now, deps.database);
      await insertIssueComment({
        issueId: c.issueId,
        workspaceId: c.workspaceId,
        kind: "merge-attempt",
        author: "system",
        body:
          `This branch (${c.branch}) conflicts with ${repo.baseBranch} and the board's rebase hit conflicts, so it is no longer ` +
          `ready for merge: its builder gets one fix turn (${sent.count + 1} of ${HEAL_MAX_TURNS}).\n\nConflict: ${reason}`,
        payload: { eventType: "base-conflict-fix-turn", files, baseCommits },
        createdAt: now,
      }, deps.database);
      try {
        if (await deps.hasLiveSession(c.workspaceId).catch(() => true)) await deps.sendTurn(c.workspaceId, prompt);
        else await deps.relaunch(c.workspaceId, prompt);
      } catch (err) {
        await setWorkspaceReadyForMerge(c.workspaceId, now, deps.database).catch(() => undefined);
        console.warn(`[ready-base-conflict] ${who}: fix turn not delivered, readyForMerge restored: ${errorMessage(err).slice(0, 200)}`);
        continue;
      }
      turnsSent.set(c.workspaceId, { count: sent.count + 1, lastTipSha: tip });
      report.turned.push(c.workspaceId);
      console.log(`[ready-base-conflict] ${who} conflicts with ${repo.baseBranch} in ${files.join(", ")} - builder given one fix turn`);
    } catch (err) {
      console.warn(`[ready-base-conflict] ${who} failed (non-fatal): ${errorMessage(err).slice(0, 200)}`);
    }
  }
  return report;
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
let activeSweep: PeriodicSweepHandle | null = null;

export function stopReadyBaseConflictHealer(): void {
  activeSweep?.stop();
  activeSweep = null;
}

export function startReadyBaseConflictHealer(deps: ReadyBaseConflictHealDeps, intervalMs = DEFAULT_INTERVAL_MS): PeriodicSweepHandle {
  stopReadyBaseConflictHealer();
  activeSweep = startPeriodicSweep({
    name: "ready-base-conflict",
    tick: () => reconcileReadyBaseConflicts(deps),
    bootDelayMs: 30_000,
    intervalMs,
  });
  return activeSweep;
}

/** Test seam. */
export function resetReadyBaseConflictHealerStateForTests(): void {
  lastProbeMs.clear();
  turnsSent.clear();
}
