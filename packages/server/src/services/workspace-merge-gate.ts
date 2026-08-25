/**
 * Pre-merge gate orchestration for the merge path — extracted from `workspace-merge.service.ts`
 * (which hit the 1000-line god-module ceiling).
 *
 * Three cohesive concerns live here, all about the GATE rather than about merging:
 *   - {@link recordGateFailureNote}: how a withhold is written to the issue timeline, deduped.
 *   - {@link runPreLockGate}: running the gate BEFORE the repo lock is taken, and converting a
 *     pass into an `already-passed` proof token for the merge executor.
 *   - {@link reusePersistedGateVerdict} / the persist half inside `runPreLockGate` (#893):
 *     a completed PASS survives a backend restart in `workspace_merge_gate`, so a merge
 *     retry after a tsx-watch reload reuses the verdict instead of re-paying the run.
 *
 * Why the gate runs before the lock: the gate (`verify_script` — tests + build) takes 20-40
 * minutes on this repo while the git work the lock guards takes seconds. Holding the lock across
 * the gate made it a repo-wide throughput cap — one merge per gate duration — and made a FAILING
 * gate the most expensive case of all, since it blocked every other workspace for its full run
 * and landed nothing (measured: a 41-minute gate that then failed, with three workspaces ready
 * behind it).
 *
 * This is not a weakening of the gate. `already-passed` evidence is exactly what the in-process
 * monitor has always handed the merge path (it gates during its cycle, then merges), and
 * `resolveMergeGate` rejects evidence older than `MERGE_GATE_EVIDENCE_MAX_AGE_MS` by re-running
 * the gate under the lock. A long wait for the lock therefore degrades to precisely the old
 * behaviour; the common case holds the lock for seconds.
 */
import type { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getLatestIssueCommentByKind } from "../repositories/issue-comments.repository.js";
import { getMergeGateEvidence, setMergeGateEvidence } from "../repositories/merge-gate.repository.js";
import { WorkspaceError } from "./workspace-internals.js";
import {
  gateAlreadyPassed,
  resolveMergeGateShas,
  type MergeGateShas,
  type MergeGateToken,
  type PreMergeGateWorkspace,
} from "./pre-merge-gate.service.js";
import { resolveGateVerification } from "./pre-merge-gate-tier.js";
import { runGateWithEvidence } from "./merge-gate-evidence.js";

// The #243 sha comparison moved next to the protocol that uses it (#540). Re-exported here
// because this is the path callers and suites already import it from.
export { movedDuringGate } from "./merge-gate-evidence.js";
import { getBaseBranchHealthAtMergeBase, describeRedBaseAttribution } from "./base-branch-health.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * The merge service's timeline recorder. `eventType` is a closed union rather than a string, so
 * mistyping an event name is a compile error — keep it that way when threading it through here.
 */
type RecordMergeAttempt = (
  workspace: WorkspaceRow,
  eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed" | "gate-failed",
  body: string,
  payload?: Record<string, unknown>,
) => Promise<void>;

/**
 * Record a pre-merge-gate withhold, deduped against the most recent gate-failure note for this
 * issue: an orchestrator tick retries every ~30s, so an unchanged verify/smoke failure would
 * otherwise spam a fresh "merge-attempt" comment every cycle (#170). Only inserts a new note
 * when the gate message actually changed (new failure signature) or none was recorded yet.
 */
/**
 * The `mergeReason` tag a pre-merge-gate withhold carries on its `WorkspaceError`.
 *
 * The withhold uses the "CONFLICT" error CODE (for HTTP-status purposes) but is emphatically
 * not a merge conflict, and every caller that recovers from a merge failure has to tell the
 * two apart. Callers used to sniff for this themselves, or — worse — not at all: #638 was the
 * monitor treating a red verify gate exactly like a dirty worktree and handing it to
 * fix-and-merge, which merges without ever running the gate.
 */
export const PRE_MERGE_GATE_FAILURE_REASON = "pre_merge_gate_failed";

/**
 * True when a rejected merge was withheld BY THE GATE rather than by a conflict/lock/etc.
 *
 * A batch reconciler or fix agent cannot fix a red verify script, so this is the predicate
 * that keeps such a failure out of every agent-driven retry path (#170 for the merge queue,
 * #638 for the monitor). It reads the structured `data.mergeReason` the withhold sets — never
 * the message text, which is localized prose.
 */
export function isPreMergeGateFailure(err: unknown): boolean {
  const data = err instanceof Error ? (err as unknown as { data?: { mergeReason?: string } }).data : undefined;
  return data?.mergeReason === PRE_MERGE_GATE_FAILURE_REASON;
}

export async function recordGateFailureNote(args: {
  workspace: WorkspaceRow;
  stage: string;
  gateMessage: string;
  targetBranch: string;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<void> {
  const { workspace, stage, gateMessage, targetBranch, database, recordMergeAttempt } = args;
  try {
    const latest = await getLatestIssueCommentByKind(workspace.issueId, "merge-attempt", database);
    const latestPayload = latest?.payload ? (JSON.parse(latest.payload) as Record<string, unknown>) : null;
    if (latestPayload?.mergeReason === "pre_merge_gate_failed" && latestPayload?.gateMessage === gateMessage) {
      return; // identical failure repeating — already recorded, don't spam another note
    }
  } catch (err) {
    console.warn(
      "[workspace-merge] failed to check prior gate-failure note (non-fatal):",
      errorMessage(err),
    );
  }
  await recordMergeAttempt(
    workspace,
    "gate-failed",
    `Merge withheld: pre-merge gate failed (${stage}). ${gateMessage}`,
    { mergeReason: "pre_merge_gate_failed", gateStage: stage, gateMessage, targetBranch },
  );
}

/**
 * Record that a merge was verified by NOTHING, because the project has nothing to verify with (#377).
 *
 * MEASURED reason this exists: eight tickets were auto-merged into a project with no `verify_script`
 * and an all-null stack profile. One carried a test that could never pass, master went 38/38 green to
 * 40-with-1-permanently-failing, and no signal was produced anywhere — because "no gate configured"
 * and "gate passed" were both `passed: true` with identical silence. A merge nothing checked is a
 * fact about that merge and belongs on the timeline beside it.
 *
 * Deduped like {@link recordGateFailureNote}: the state is a property of the PROJECT, so it repeats on
 * every merge and would otherwise become noise nobody reads. Non-fatal throughout — an unrecordable
 * note must never be the thing that stops a merge.
 */
export async function recordUnverifiedMergeNote(args: {
  workspace: WorkspaceRow;
  gateMessage: string;
  targetBranch: string;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<void> {
  const { workspace, gateMessage, targetBranch, database, recordMergeAttempt } = args;
  try {
    const latest = await getLatestIssueCommentByKind(workspace.issueId, "merge-attempt", database);
    const latestPayload = latest?.payload ? (JSON.parse(latest.payload) as Record<string, unknown>) : null;
    if (latestPayload?.mergeReason === "merged_without_verification") return;
    await recordMergeAttempt(
      workspace,
      "warning",
      "Merging WITHOUT verification: this project has no verify_script and no smoke check, so no test "
      + `suite gated this merge. ${gateMessage}`,
      { mergeReason: "merged_without_verification", gateStage: "none", gateMessage, targetBranch },
    );
  } catch (err) {
    console.warn(
      "[workspace-merge] failed to record unverified-merge note (non-fatal):",
      errorMessage(err),
    );
  }
}

/**
 * How long a PERSISTED gate PASS may be reused by a merge (re)attempt (#893).
 *
 * Deliberately much longer than `MERGE_GATE_EVIDENCE_MAX_AGE_MS` (15 min): reuse here is
 * additionally pinned to BOTH tips and to the verification tier, so the proof describes the
 * exact merge about to happen — content-keyed evidence, where age adds little. The bound
 * exists so that a workspace parked for a day does not merge on a days-old run whose
 * environment (toolchain, flaky-suite health, base-adjacent state the tips cannot see) has
 * drifted; a few hours comfortably covers the failure this exists for — a tsx-watch backend
 * restart discarding a 39-minute run that passed minutes earlier.
 */
export const PERSISTED_GATE_VERDICT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** The persisted-evidence stages a merge may reuse. `"none"` is a record of NO verification. */
const REUSABLE_GATE_STAGES = new Set(["verify", "smoke"]);

/**
 * Turn a persisted gate PASS back into an `already-passed` token, when — and only when — it
 * still describes the exact merge about to happen (#893).
 *
 * The failure this closes: `POST /:id/merge` runs the gate inline (30-45 min here) and held
 * its verdict only in the request's memory plus the in-memory #492 tree memo. A tsx-watch
 * backend restart (a 5-second event) discarded both, so the retry re-paid the full run for
 * code that had ALREADY passed. Only failures stay unpersisted — a red verdict is never
 * reused to block; the gate re-runs instead (same reasoning as the tree memo: a false red is
 * cheap to re-run, a false green is not — and this path can only ever mint a green token).
 *
 * Reuse requires ALL of:
 *  - a persisted row whose stage is a real run (`verify`/`smoke`; `"none"`/null is a record
 *    of nothing having run — see #642),
 *  - BOTH recorded tips present and equal to the CURRENT branch/base tips (content match,
 *    same rule as `contentMatch` in the gate's own evidence validation),
 *  - an unchanged verification tier: the recorded `verificationKey` equals
 *    `gateVerificationKey(strategy, verifyCommand)` resolved NOW. A null recorded key
 *    (pre-#893 evidence) fails this — reuse must never guess what a pass verified,
 *  - `ranAt` younger than {@link PERSISTED_GATE_VERDICT_MAX_AGE_MS} and not in the future.
 *
 * Anything else — including any read error — returns null, and the caller runs the gate.
 */
export async function reusePersistedGateVerdict(args: {
  workspaceId: string;
  workspace: PreMergeGateWorkspace;
  projectId: string;
  database: Database;
  nowMs?: number;
  /** Injectable reads, mirroring `runGateWithEvidence` — tests need no repo/DB. */
  readEvidence?: (
    workspaceId: string,
    database: Database,
  ) => Promise<
    | {
        ranAt: string | null;
        stage: string | null;
        source: string | null;
        branchSha: string | null;
        baseSha: string | null;
        verificationKey: string | null;
      }
    | undefined
  >;
  readShas?: (workspace: PreMergeGateWorkspace) => Promise<MergeGateShas>;
  readVerificationKey?: (projectId: string, database: Database) => Promise<string>;
}): Promise<MergeGateToken | null> {
  const { workspaceId, workspace, projectId, database } = args;
  const nowMs = args.nowMs ?? Date.now();
  const readEvidence = args.readEvidence ?? getMergeGateEvidence;
  const readShas = args.readShas ?? resolveMergeGateShas;
  const readVerificationKey =
    args.readVerificationKey ??
    (async (projectId_: string, database_: Database) =>
      (await resolveGateVerification(projectId_, database_)).verificationKey);
  try {
    const evidence = await readEvidence(workspaceId, database);
    if (!evidence?.ranAt || !evidence.stage || !REUSABLE_GATE_STAGES.has(evidence.stage)) return null;
    if (!evidence.branchSha || !evidence.baseSha || !evidence.verificationKey) return null;
    const ranAtMs = Date.parse(evidence.ranAt);
    if (Number.isNaN(ranAtMs)) return null;
    const ageMs = nowMs - ranAtMs;
    if (ageMs < 0 || ageMs > PERSISTED_GATE_VERDICT_MAX_AGE_MS) return null;
    const current = await readShas(workspace);
    if (!current.branchSha || !current.baseSha) return null;
    if (current.branchSha !== evidence.branchSha || current.baseSha !== evidence.baseSha) return null;
    if ((await readVerificationKey(projectId, database)) !== evidence.verificationKey) return null;
    return gateAlreadyPassed({
      ranAt: evidence.ranAt,
      stage: evidence.stage as "verify" | "smoke",
      // Name the reuse in the source so the executor's "already passed (…)" message says what
      // happened instead of implying the gate ran in this request (#893 part 3).
      source: `${evidence.source ?? "unknown"} (persisted verdict reused)`,
      branchSha: evidence.branchSha,
      baseSha: evidence.baseSha,
    });
  } catch (err) {
    // A broken read must never withhold (or worse, grant) a merge — fall back to a real run.
    console.warn(
      `[workspace-merge] persisted gate-verdict reuse check failed for workspace ${workspaceId} (non-fatal, gate will run):`,
      errorMessage(err),
    );
    return null;
  }
}

/**
 * Persist a completed gate PASS so a backend restart cannot discard it (#893). Non-fatal by
 * design: an unrecordable verdict must never stop the merge that just earned it.
 */
async function persistGateVerdict(args: {
  workspaceId: string;
  projectId: string;
  ranAt: string;
  stage: string;
  source: string;
  branchSha: string | null;
  baseSha: string | null;
  database: Database;
}): Promise<void> {
  const { workspaceId, projectId, ranAt, stage, source, branchSha, baseSha, database } = args;
  try {
    // Resolved AFTER the run, so the key names the tier in force now — the one the reuse
    // check will compare against. (A mid-run tier change makes the key mismatch and the
    // verdict unreusable, which errs on re-running: the safe direction.)
    const { verificationKey } = await resolveGateVerification(projectId, database);
    await setMergeGateEvidence(workspaceId, { ranAt, stage, source, branchSha, baseSha, verificationKey }, database);
  } catch (err) {
    console.warn(
      `[workspace-merge] failed to persist gate verdict for workspace ${workspaceId} (non-fatal):`,
      errorMessage(err),
    );
  }
}

/**
 * The persisted gate PASS for a workspace, as a small DTO for the merge-status endpoint
 * (#893 part 3) — so a caller whose merge died on TRANSPORT after its gate passed can be told
 * "the verdict is stored; a retry will reuse it" instead of a bare "no job recorded". Null when
 * nothing (or only a record of no verification) is persisted. Never throws.
 */
export async function describePersistedGateVerdict(
  workspaceId: string,
  database: Database = db,
): Promise<{ ranAt: string; stage: string; source: string | null; branchSha: string | null; baseSha: string | null; reusable: boolean } | null> {
  try {
    const evidence = await getMergeGateEvidence(workspaceId, database);
    if (!evidence?.ranAt || !evidence.stage || !REUSABLE_GATE_STAGES.has(evidence.stage)) return null;
    return {
      ranAt: evidence.ranAt,
      stage: evidence.stage,
      source: evidence.source,
      branchSha: evidence.branchSha,
      baseSha: evidence.baseSha,
      // "Reusable" here is the cheap half of the check (tips + tier are compared at merge
      // time, against the state then): a verdict with both tips, a tier key, and a fresh run.
      reusable: Boolean(
        evidence.branchSha &&
          evidence.baseSha &&
          evidence.verificationKey &&
          Date.now() - Date.parse(evidence.ranAt) <= PERSISTED_GATE_VERDICT_MAX_AGE_MS,
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Run the pre-merge gate OUTSIDE the repo lock and return the token the merge executor should
 * use.
 *
 * - Gate fails → throws, WITHOUT the lock ever being taken. That is the point: a red gate must
 *   not block other workspaces from merging.
 * - Gate passes and actually RAN → returns an `already-passed` token carrying the proof, so the
 *   executor does not pay for the same expensive run twice.
 * - Gate was skipped / no project / nothing to gate → returns the caller's original token and
 *   lets the executor resolve it (cheaply) under the lock. A "none" outcome carries no evidence
 *   worth trusting.
 *
 * Callers must invoke this AFTER their refuse/reuse check: when another merge is already in
 * flight the call is going to be refused anyway, and gating first would burn a full test run
 * just to produce that refusal.
 */
export async function runPreLockGate(args: {
  workspaceId: string;
  workspace: WorkspaceRow;
  projectId: string | null;
  baseBranch: string;
  token: MergeGateToken;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<MergeGateToken> {
  const { workspaceId, workspace, projectId, baseBranch, token, database, recordMergeAttempt } = args;
  if (!projectId || token.kind !== "run-gate") return token;
  // #276 — a DIRECT workspace's merge lands nothing. Its branch IS the default branch, and
  // `doMerge` short-circuits it to a plain close (handleWorkspaceMergeResolution →
  // "direct-closed"). But that short-circuit is evaluated inside the executor, i.e. AFTER
  // this gate, so closing a direct workspace used to pay a full verify run first — observed
  // on #232: a ~50-minute build+test that then timed out (`verify_script timed out after
  // 3000000ms`) to close a workspace that was never going to merge anything. There is no
  // diff to verify, so there is nothing here to gate.
  if (workspace.isDirect) {
    console.log(`[workspace-merge] skipping pre-lock gate for direct workspace ${workspaceId} — a direct merge lands nothing (#276)`);
    return token;
  }

  // #540: the #243 pin-run-repin-mint protocol lives in ONE place now.
  // `baseBranch` matters: without it the gate cannot read the diff, so every diff-derived
  // cost decision silently degrades to its most expensive branch — the docs-only skip
  // (#198) could never fire on the merge path, and the test-package scoping cannot either.
  const gateWorkspace = { id: workspaceId, workingDir: workspace.workingDir, baseBranch };

  // #893 — before paying a 30-45 minute run, check whether THIS exact merge (same branch tip,
  // same base tip, same verification tier) already passed and the verdict was persisted. That
  // is what survives the failure this ticket is about: the gate passed, then a tsx-watch
  // backend restart killed the request that held the verdict in memory, and the retry re-ran
  // everything. Only passes are ever persisted, so this can never convert a red gate into a
  // merge — a missing/stale/mismatched verdict simply falls through to a real run.
  const reused = await reusePersistedGateVerdict({ workspaceId, workspace: gateWorkspace, projectId, database });
  if (reused) {
    console.log(
      `[workspace-merge] pre-lock gate reusing PERSISTED verdict for workspace ${workspaceId} — ` +
        `same branch/base tips and verification tier as the recorded pass (#893); skipping the gate run`,
    );
    return reused;
  }

  console.log(`[workspace-merge] pre-lock gate phase=start workspaceId=${workspaceId}`);
  const preGate = await runGateWithEvidence({
    workspace: gateWorkspace,
    projectId,
    source: "pre-lock-merge",
    database,
  });

  if (!preGate.passed) {
    // #491 — before blaming this branch, check whether the base was ALREADY red at the
    // branch's merge-base. Best-effort: a failure here must never mask the real gate failure,
    // it can only ADD attribution to it.
    let gateMessage = preGate.message;
    if (workspace.workingDir) {
      try {
        const baseHealth = await getBaseBranchHealthAtMergeBase(
          projectId,
          workspace.workingDir,
          "HEAD",
          baseBranch,
          database,
        );
        const attribution = describeRedBaseAttribution(baseHealth);
        if (attribution) gateMessage = `${attribution}\n\n${preGate.message}`;
      } catch (err) {
        console.warn(
          "[workspace-merge] failed to resolve base-branch health attribution (non-fatal):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await recordGateFailureNote({
      workspace,
      stage: preGate.stage,
      gateMessage,
      targetBranch: baseBranch,
      database,
      recordMergeAttempt,
    });
    throw new WorkspaceError(
      `Pre-merge gate failed (${preGate.stage}) — merge withheld. ${gateMessage}`,
      "CONFLICT",
      { mergeReason: PRE_MERGE_GATE_FAILURE_REASON, gateStage: preGate.stage },
    );
  }

  if (preGate.unverified) {
    // Say it out loud on the timeline AND in the log. Deliberately not a block: plenty of projects
    // legitimately have nothing to gate on, and refusing their merges would be a worse defect than
    // the silence. What was missing was the SAYING (#377).
    console.warn(`[workspace-merge] merging workspace ${workspaceId} with NO verification configured for project ${projectId} (#377)`);
    await recordUnverifiedMergeNote({
      workspace,
      gateMessage: preGate.message,
      targetBranch: baseBranch,
      database,
      recordMergeAttempt,
    });
  }

  if (!preGate.ran) return token;

  console.log(
    `[workspace-merge] pre-lock gate passed workspaceId=${workspaceId} stage=${preGate.stage}; acquiring lock`,
  );
  // The minted evidence pins the exact state that was verified. That is what lets the in-lock
  // re-resolve accept the pass after an arbitrarily long lock wait (no pointless re-gate)
  // while still catching the case that genuinely invalidates it: another merge landed and
  // moved the base, so the merge RESULT is no longer what was tested.
  if (!preGate.token) {
    console.warn(
      `[workspace-merge] pre-lock gate passed for workspace ${workspaceId} but the ${preGate.moved} moved DURING the run ` +
        `— minting no evidence (#243); the merge executor will re-gate under the lock.`,
    );
    return token;
  }
  // #893 — the run that just passed cost real minutes; make the verdict survive a backend
  // restart. Written for a REAL run with steady tips only (this branch), which is exactly what
  // the reuse check above requires back. Non-fatal: see persistGateVerdict.
  await persistGateVerdict({
    workspaceId,
    projectId,
    ranAt: preGate.ranAt,
    stage: preGate.stage,
    source: "pre-lock-merge",
    branchSha: preGate.shasBefore.branchSha ?? null,
    baseSha: preGate.shasBefore.baseSha ?? null,
    database,
  });
  return preGate.token;
}

