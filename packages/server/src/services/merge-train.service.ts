import { isAncestor, mergeBranch, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAttemptDto, MergeTrainAttemptVerdict, MergeTrainBaseVerdict } from "@agentic-kanban/shared/types";
import { verifyChainSemaphoreActive, verifyChainSemaphoreConcurrency } from "./verify-chain-semaphore.js";
import {
  assembleMergeTrain,
  assertTrainPreservesAncestry,
  dedupeConflictClusters,
  formatTrainLabel,
  parentTrainLabel,
  trainDateStamp,
  trainRefName,
  type ConflictCluster,
  type DroppedTrainMember,
  type TrainAssemblyResult,
  type TrainMember,
} from "./merge-train-assembly.js";

/**
 * Release trains: gate N tickets ONCE instead of N times.
 *
 * Today every member of a merge wave pays its own full pre-merge gate — on this repo
 * `check:arch && typecheck && test:mine && build`, 30-45 minutes — and they serialize behind
 * the repo lock, so a wave of 4 costs 4 gates. A train instead assembles the members onto one
 * integration ref, gates that ref once, and lands it as a batch.
 *
 * It is also STRICTLY MORE correct than the per-ticket gate, which is the part worth
 * understanding: a per-ticket gate verifies the feature branch in isolation, un-rebased. It
 * never tests the two-parent merge commit that actually lands, so two branches that are each
 * green can merge to a red master with no textual conflict at all (a semantic conflict —
 * `merge-tree` reports no problem and the merge proceeds). A train gates the assembled tree,
 * which IS what lands.
 *
 * The ANCESTRY invariant (--no-ff, never squash, never rebase a member into the train) and the
 * ASSEMBLY step that builds the integration ref both live in `merge-train-assembly.ts` (split
 * out to stay under the god-module gate's 1000-line ceiling); this module re-exports them so no
 * importer needs to know about the split.
 */

export {
  assembleMergeTrain,
  assertTrainPreservesAncestry,
  formatTrainLabel,
  parentTrainLabel,
  trainDateStamp,
  trainRefName,
  type ConflictCluster,
  type DroppedTrainMember,
  type TrainAssemblyResult,
  type TrainMember,
};

/** The structural trailer a landed train's merge commit carries — see {@link buildMergeTrainCommitMessage}. */
export const MERGE_TRAIN_TRAILER_KEY = "Merge-Train";

/** Parse a `Merge-Train: <id>` trailer out of a commit message/subject. Null when absent. */
export function parseMergeTrainTrailer(message: string): string | null {
  const m = message.match(/^Merge-Train:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

export interface TrainGateEvidenceForMessage {
  /** The train row id (`merge_trains.id`) — carried in the trailer for structural matching. */
  trainId: string;
  /**
   * The label of the attempt that actually landed, when it is a bisect sub-attempt
   * (`train/2026-09-17-03a`). Absent (or equal to the parent) for a whole-train landing.
   */
  attemptLabel?: string;
  trainSha: string;
  baseSha: string;
  gateRuns: number;
  /** The gate's own message, e.g. a tier line ("pre-merge gate passed (tier: file-scoped, …)"). */
  gateMessage: string;
}

/**
 * Compose the landing merge commit's subject + body (#1190).
 *
 * Subject names the PARENT train label and every member's issue number, e.g.
 * `Merge train 2026-09-17-03: #1176 #1177` — readable in `git log --oneline` without opening the
 * commit. The body lists each member (issue, branch, tip sha) plus the gate evidence (train sha,
 * base sha, gate run count, the gate's own tier message) and ends with a `Merge-Train: <row id>`
 * trailer so a reconciler can match this commit to its `merge_trains` row structurally — by the
 * trailer, not by re-parsing the human-readable label text.
 */
export function buildMergeTrainCommitMessage(args: {
  parentLabel: string;
  included: TrainMember[];
  evidence: TrainGateEvidenceForMessage;
}): string {
  const { parentLabel, included, evidence } = args;
  // `parentLabel` still carries the `train/` prefix (see `trainRefName`) — the subject reads
  // better without repeating "train train/...", so strip it once here.
  const displayLabel = parentLabel.startsWith("train/") ? parentLabel.slice("train/".length) : parentLabel;
  const issueRefs = included
    .filter((m) => m.issueNumber != null)
    .map((m) => `#${m.issueNumber}`)
    .join(" ");
  const subject = `Merge train ${displayLabel}${issueRefs ? `: ${issueRefs}` : ""}`;

  const memberLines = included.map((m) => {
    const issue = m.issueNumber != null ? `#${m.issueNumber}` : "(no issue)";
    return `- ${issue} ${m.branch} @ ${m.tipSha?.slice(0, 12) ?? "?"}`;
  });

  const attemptLine =
    evidence.attemptLabel && evidence.attemptLabel !== parentLabel ? [`Attempt: ${evidence.attemptLabel}`] : [];

  const body = [
    "",
    ...memberLines,
    "",
    ...attemptLine,
    `Gate: ${evidence.gateRuns} run(s) — ${evidence.gateMessage}`,
    `Train sha: ${evidence.trainSha}`,
    `Base sha: ${evidence.baseSha}`,
    "",
    `${MERGE_TRAIN_TRAILER_KEY}: ${evidence.trainId}`,
  ];

  return [subject, ...body].join("\n");
}

/**
 * Land an assembled, GATED train onto the base branch.
 *
 * Caller contract: the gate must already have passed against `trainSha`. This function
 * re-checks the ancestry invariant and refuses to land a train whose base moved underneath it
 * (that would land a tree nobody verified) — it does NOT re-run the gate itself, because
 * deciding that belongs to the caller that owns the gate token.
 *
 * `evidence` is optional so existing callers/tests that don't need a self-describing commit
 * (e.g. asserting only on `mergeSha`) keep working unchanged; when present, the merge commit's
 * message is composed by {@link buildMergeTrainCommitMessage} instead of `mergeBranch`'s default
 * `Merge branch '<trainRef>'`.
 */
export async function landMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  trainRef: string;
  trainSha: string;
  baseSha: string;
  included: TrainMember[];
  /** The train's own label (parent or sub-attempt) — used to derive the parent label for the subject. */
  label?: string;
  evidence?: Omit<TrainGateEvidenceForMessage, "trainSha" | "baseSha">;
}): Promise<{ mergeSha: string; mergeMessage: string }> {
  const { repoPath, baseBranch, trainRef, trainSha, baseSha, included, label, evidence } = args;
  if (included.length === 0) throw new Error(`[merge-train] refusing to land empty train ${trainRef}`);

  const currentBase = await revParse(repoPath, baseBranch);
  if (currentBase !== baseSha) {
    throw new Error(
      `[merge-train] base '${baseBranch}' moved from ${baseSha.slice(0, 8)} to ${currentBase.slice(0, 8)} ` +
        `after the train was gated — refusing to land an unverified tree. Reassemble and re-gate.`,
    );
  }
  const currentTrain = await revParse(repoPath, trainRef);
  if (currentTrain !== trainSha) {
    throw new Error(
      `[merge-train] train ${trainRef} moved from ${trainSha.slice(0, 8)} to ${currentTrain.slice(0, 8)} after gating — refusing to land.`,
    );
  }

  await assertTrainPreservesAncestry(repoPath, trainRef, included, baseBranch);

  const includedWithTips: TrainMember[] = [];
  for (const member of included) {
    const tipSha = await revParse(repoPath, member.branch).catch(() => null);
    includedWithTips.push({ ...member, tipSha: tipSha ?? undefined });
  }

  const message = label && evidence
    ? buildMergeTrainCommitMessage({
        parentLabel: parentTrainLabel(label),
        included: includedWithTips,
        evidence: { ...evidence, trainSha, baseSha, attemptLabel: label },
      })
    : undefined;

  // `mergeBranch` resolves with a human-readable MESSAGE, not a SHA, so read the resulting
  // base tip explicitly — callers want the commit that landed, for stamping and for logs.
  const mergeMessage = await mergeBranch(repoPath, trainRef, baseBranch, message ? { message } : undefined);
  const mergeSha = await revParse(repoPath, baseBranch);
  // Post-condition: every member is now reachable from the base. This is what lets each
  // member be stamped as merged and keeps the reconcilers from treating them as lost work.
  for (const member of included) {
    const tip = await revParse(repoPath, member.branch);
    if (!(await isAncestor(repoPath, tip, baseBranch))) {
      throw new Error(
        `[merge-train] landed ${trainRef} into ${baseBranch} but member ${member.branch} is NOT an ancestor — ` +
          `refusing to report success; the batch must be reconciled by hand.`,
      );
    }
  }
  return { mergeSha, mergeMessage };
}

/**
 * Run a full train: assemble → gate ONCE → land → close each member out.
 *
 * Injected ports rather than direct imports, so the orchestration is testable without a
 * server, a DB, or a 40-minute gate:
 *  - `runGate` gates the assembled train. It receives the train ref and a worktree path the
 *    caller prepared for it (the gate must run the project's verify script against the
 *    train's tree, not a member's).
 *  - `closeMember` marks a member merged. Pass the EXISTING `reconcileAlreadyMerged` here:
 *    once the train has landed, every member's tip is an ancestor of the base, which is
 *    exactly the precondition that function checks. Reusing it means the train does not
 *    reimplement mergedAt/status/issue-comment bookkeeping — the part where a bespoke
 *    implementation would silently diverge from the reconcilers.
 *
 * A red train lands NOTHING. The members are untouched, so the caller falls back to the
 * per-ticket path, which is slower but attributes the failure to a single ticket.
 */
export interface TrainRunResult {
  trainRef: string;
  landed: TrainMember[];
  /** Could not be assembled — `deferred` ones wait for the next train, the rest need a rebase. */
  dropped: DroppedTrainMember[];
  /** Set when the batch did not land; the members remain unmerged. */
  gateFailure?: string;
  /**
   * How many gate runs this train cost, INCLUDING bisect re-gates (#492). The happy path is
   * 1 for any batch size — the whole point — and a reader needs to see when it was not, or
   * the "N merges, 1 gate" claim is unfalsifiable.
   */
  gateRuns: number;
  /**
   * Members a bisect individually proved red (#492). They are NOT in `landed` and NOT in
   * `dropped` — `dropped` means "could not be assembled" (a conflict), this means "assembled
   * fine and failed the gate on its own". Keeping them apart matters: a conflict is the
   * author's to rebase, a gate failure is the author's to FIX, and reporting one as the other
   * sends them to the wrong place.
   */
  gateRejected: Array<{ member: TrainMember; reason: string }>;
  /**
   * #1194 — members a TRAIN REVIEW attributed a blocking finding to (`runGate`'s `sided`).
   * Neither `dropped` (a conflict) nor `gateRejected` (the code itself failed the gate): the
   * assembled tree passed the gate fine, but the reviewer found a problem specific to this
   * member's ticket. Pulled from `included` and re-landed without them — same "don't fail the
   * whole train for one member" shape as `dropped`/`gateRejected`, a third reason a member can
   * leave a train before landing.
   */
  sided: Array<{ member: TrainMember; reason: string }>;
  mergeSha?: string;
  /** Members that landed but could not be closed out — they ARE merged; only bookkeeping lags. */
  closeFailures: Array<{ member: TrainMember; reason: string }>;
  /**
   * #1181 — set when the gate PASSED but `shouldLand` refused the landing (the train's row was
   * abandoned while it ran). Distinct from `gateFailure`: nothing about the code is red, so
   * the bisect driver must not split on it and no member may be blamed for it.
   */
  landRefused?: string;
  /**
   * #1203 — true when `signal` was already aborted before an attempt (root or a bisect half)
   * even started, so that attempt spent NO gate run at all. Distinct from `landRefused`, which
   * is asked once after a green gate: this can end the job before, during (the running gate's
   * child process killed), or between bisect halves — anywhere `landGreenest` checks the signal.
   */
  cancelled?: true;
  /**
   * #1189 — one node per assemble → gate → land cycle, in the order they finished (a bisect's
   * root first, then its halves depth-first). The tree the panel renders; the sum of the nodes'
   * `gateRuns` is `gateRuns` above.
   */
  attempts: MergeTrainAttemptDto[];
  /**
   * #1191 — every member-vs-member conflict cluster found across every attempt (deduped by
   * member set), for the caller to feed to `propose_ticket_groups`/`group-scan`. A cluster here
   * means those tickets collided on THIS train's conflict graph — nothing here is written
   * anywhere by this module; the caller decides whether/how to propose it. Optional (defaults to
   * empty) so a hand-built result in a test — this module's own included — doesn't have to name
   * it every time.
   */
  conflictClusters?: ConflictCluster[];
  /**
   * #1204 — the CONTROL ARM's verdict on the BARE BASE, when `gateBaseAlone` was asked. `red`
   * means the failure is the base's own, so nothing here is attributed to a member; `green`
   * means the base was clean and the bisect's attribution stands. Absent when no control arm
   * ran (a green train, an environment failure, or a caller that wires no port).
   */
  baseVerdict?: MergeTrainBaseVerdict;
}

/**
 * The gate port. `sided` (#1194) is set when a train-scoped review ran beside the gate and
 * attributed a blocking finding to specific members. Only meaningful when `passed` is true: a
 * review finding pulls its member into a siding, it does not fail the gate for everyone else.
 */
export type TrainGate = (ctx: {
  trainRef: string;
  trainSha: string;
  included: TrainMember[];
  /**
   * The ATTEMPT's label (`q1`, `q1a`, `q1b`, …), not the train's — #1193 gates two bisect
   * halves at once, so a caller keying anything per gate (its synthetic workspace id, log
   * lines) must key it per half or the two runs become indistinguishable.
   */
  label: string;
}) => Promise<{
  passed: boolean;
  message: string;
  sided?: Array<{ workspaceId: string; reason: string }>;
}>;

export async function runMergeTrain(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  /**
   * #1190 — the persisted `merge_trains.id`, carried into the landing merge commit's
   * `Merge-Train:` trailer so a reconciler can match structurally. Optional: a caller with no
   * persisted row (a test, or a future non-DB-backed use) gets today's default commit message.
   */
  trainId?: string;
  runGate: TrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  /**
   * Bisect a red batch instead of rejecting it whole (#492). Default ON: without it, one bad
   * branch blocks every other branch in the queue indefinitely, which is the failure mode
   * that made batching not worth having. Set false to restore the all-or-nothing behaviour.
   */
  bisectOnFailure?: boolean;
  /**
   * Does this gate failure message describe a BROKEN ENVIRONMENT (missing dependency, absent
   * tool) rather than a real regression in the code (#1154)? Bisecting such a failure is worse
   * than useless: every half of the split shares the same broken staging worktree, so each
   * re-gate reproduces the identical verdict, and halving down to single members eventually
   * blames an arbitrary branch for a problem that is not in its code at all — observed as a
   * 9-gate-run, 3h23m train that landed nothing over a missing `packages/e2e` install.
   *
   * When this returns true, the whole subset is treated as attribution-free: `gateFailure` is
   * kept, but nobody is added to `gateRejected` and no split is attempted. Optional so a caller
   * that never classifies failures gets today's behaviour unchanged.
   */
  isEnvironmentFailure?: (message: string) => boolean;
  /**
   * #1181 — asked ONCE, after a green gate and immediately before `landMergeTrain`. Return a
   * refusal reason to leave the base untouched (the result then carries `landRefused` and the
   * gate failure text, lands nothing, and is not bisected), or null to land. The caller uses
   * it to re-read the train's row: a row marked `abandoned` mid-gate must not land.
   */
  shouldLand?: () => Promise<string | null>;
  /**
   * #1189 — called once per attempt, AS IT FINISHES, with the node that also lands in the
   * result's `attempts`. The caller persists it so a live train shows partial progress rather
   * than a tree that appears whole at the end. Best-effort: a throw here is logged and never
   * fails the train — the merge already happened (or did not) regardless of the bookkeeping.
   */
  onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>;
  /**
   * #1193 — how many verify-chain slots are free RIGHT NOW, so a red bisect can gate both
   * halves of a split at once instead of one after another. Defaults to a live read of the
   * verify-chain semaphore (`verifyChainSemaphoreConcurrency() - verifyChainSemaphoreActive()`);
   * a test overrides it rather than depending on that module's process-global state.
   */
  freeVerifySlots?: () => number;
  /**
   * #1204 — the CONTROL ARM, asked ONCE when the FULL train has failed its gate and is about to
   * be halved. It gates (or reads a fresh base-health row for) the BARE BASE sha the train was
   * assembled on, and answers whether the base alone is red.
   *
   * MEASURED motivation: on a red master, a 14-member train spent 27 gate runs bisecting the
   * base's own failures and marked all 14 members `gateRejected` — the defect was on master and
   * not one of the fourteen branches had anything to do with it. One extra run at the top of the
   * search answers that question for the whole tree, so 26 of those 27 runs were avoidable.
   *
   * A `red` answer stops the search immediately and attribution-free: `gateRejected` stays
   * empty, every member stays aboard and ready, and `baseVerdict` records why. Returning null
   * (could not measure) leaves today's behaviour exactly as it was.
   */
  gateBaseAlone?: () => Promise<{ verdict: MergeTrainBaseVerdict; gateRuns: number } | null>;
  /**
   * #1203 — real cancellation. Checked by the bisect driver before EVERY attempt (the root and
   * each half), so an operator cancel ends the job after the CURRENT gate's child process is
   * killed at the latest, rather than continuing through the rest of a bisect tree. The caller
   * also passes the same signal into `runGate` (via its own closure) so the currently-running
   * verify/install process is killed rather than left to finish. Absent means "never aborts" —
   * every existing caller (a lone per-workspace gate has nothing to cancel) is unaffected.
   */
  signal?: AbortSignal;
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, runGate, closeMember } = args;
  const bisect = args.bisectOnFailure !== false;
  const isEnvironmentFailure = args.isEnvironmentFailure ?? (() => false);
  const freeVerifySlots = args.freeVerifySlots ?? defaultFreeVerifySlots;
  /**
   * #1204 — the control arm's one answer, folded into the result below (its gate run counts).
   * A REF cell rather than a `let`: the write happens inside `landGreenest`, and TypeScript's
   * control-flow analysis would otherwise narrow the outer binding to `null` at the read.
   */
  const baseProbe: { current: { verdict: MergeTrainBaseVerdict; gateRuns: number } | null } = { current: null };
  const signal = args.signal;

  /**
   * Wait for `a`, then `b` (either may be absent) — used to chain a child's landing behind
   * both its outer predecessor and, when running in parallel, its sibling's completion.
   */
  function afterBoth(a?: Promise<void>, b?: Promise<void>): Promise<void> | undefined {
    if (!a) return b;
    if (!b) return a;
    return Promise.all([a, b]).then(() => undefined);
  }

  /**
   * Land as much of `subset` as is green, splitting on failure.
   *
   * A red train of one member is ATTRIBUTION — that member is the culprit, and it goes to
   * `gateRejected` so the caller can tell its author. A red train of several is a question,
   * and halving answers it: each half is assembled against the base as it stands THEN, so a
   * green first half lands before the second half is even built. That is what keeps the good
   * branches moving past a bad one.
   *
   * Cost: 1 gate run when the batch is green (the case this feature exists for). With k bad
   * branches out of n it is bounded by O(k log n) runs — worse than n only when nearly
   * everything is red, and in that case the queue was never going to land in one run anyway.
   *
   * #1193 — `waitForPredecessor` (resolved before this subset may LAND, never before it may be
   * assembled or gated) and `notifyDone` (called once this subset's own landing — including any
   * further nested splits — is fully settled) let a caller run two halves' assemble+gate
   * CONCURRENTLY while keeping their LANDING in the original left-to-right order, which is what
   * keeps `landMergeTrain`'s base-moved refusal meaningful (the base only ever moves under a
   * half that has already had its turn).
   */
  async function landGreenest(
    subset: TrainMember[],
    subLabel: string,
    waitForPredecessor?: Promise<void>,
    notifyDone?: () => void,
  ): Promise<TrainRunResult> {
    try {
      // #1203: checked before every attempt starts — the root, and each bisect half. An
      // already-aborted signal spends NO gate run at all: no assembly, no worktree, nothing
      // for the (already-running, currently-being-killed-via-the-same-signal) gate to race
      // against. `gateRejected`/`dropped`/`sided` all stay empty, since nothing here was
      // ever attributed to any member — this is the job stopping, not a verdict about the code.
      if (signal?.aborted) {
        return {
          trainRef: `kanban/train/${subLabel}`,
          landed: [],
          dropped: [],
          gateRejected: [],
          sided: [],
          gateRuns: 0,
          gateFailure: "train cancelled",
          cancelled: true,
          closeFailures: [],
          attempts: [],
        };
      }
      const attempt = await runTrainAttempt({ ...args, members: subset, label: subLabel, isEnvironmentFailure, waitForLandTurn: waitForPredecessor });
      if (attempt.landed.length > 0 || !attempt.gateFailure) return attempt;
      // #1181: a refused landing is not a red gate — splitting would re-gate green code twice
      // and then refuse again. Stop here, attribution-free.
      if (attempt.landRefused) return attempt;
      // #1203: a gate that was itself killed by the cancel signal (mid-run, via `runGate`'s own
      // closure over the same signal) is not attribution either — stop here rather than bisect
      // an aborted run's failure onto individual members.
      if (attempt.cancelled) return attempt;
      // #1154: an environment failure fails the SAME way for every subset of the same staging
      // worktree — splitting cannot learn anything a second run at the top level didn't already
      // say, and it can only mislabel branches as individually red. Stop here, attribution-free.
      if (isEnvironmentFailure(attempt.gateFailure)) return attempt;
      // #1185: an assembly-empty subset has NO gate to blame — every member conflicted during
      // assembly and is already under `dropped` with its conflict reason. It must not be split
      // (halving would just re-discover the same conflicts) and, for a singleton, it must NOT be
      // promoted to `gateRejected`: that told the author to FIX a gate failure when the only
      // thing wrong was a conflict to REBASE (observed on trains qmu4t981a / qmu4ymqjx, whose
      // bisectResult named conflicting members with "no members could be assembled").
      if (attempt.dropped.length === subset.length) return attempt;
      // #1194: a siding only ever happens on a GREEN gate — the review attributed a finding to a
      // member, the rest were re-assembled and either landed or conflicted (both attributed). There
      // is nothing red left to search for, so splitting would only re-gate green code.
      if (attempt.sided.length > 0) return attempt;
      // #1204 — the CONTROL ARM, at the TOP of the search only (`subLabel === label`) and only
      // when there is a search to do. Every half of a bisect is assembled against the SAME base,
      // so a base that is red on its own makes every re-gate reproduce the base's failures and
      // the halving eventually blames an arbitrary branch. One run answers it for the whole tree.
      if (args.gateBaseAlone && bisect && subLabel === label && subset.length > 1) {
        baseProbe.current = await args.gateBaseAlone().catch(() => null);
        if (baseProbe.current?.verdict === "red") return attempt;
      }
      // Nothing landed and the gate is why. A red singleton IS attribution.
      if (!bisect || subset.length <= 1) {
        return {
          ...attempt,
          gateRejected: subset.length === 1
            ? [{ member: subset[0], reason: attempt.gateFailure }]
            : attempt.gateRejected,
        };
      }
      const mid = Math.floor(subset.length / 2);
      // #1193: only run both halves' assemble+gate at once when the box actually has room for a
      // second full verify chain right now — otherwise the second half's staging worktree and
      // install are pure overhead, since the semaphore would queue its gate behind the first's
      // anyway (capacity gate: CLAUDE.md).
      const canParallelize = freeVerifySlots() >= 2;
      let first: TrainRunResult;
      let second: TrainRunResult;
      if (canParallelize) {
        let releaseFirst!: () => void;
        const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
        // #1193: `allSettled`, not `all` — `all` rejects as soon as EITHER half throws while
        // the other's async work (already started, up to and including landing onto the base)
        // keeps running unobserved. That would let one half's landing complete after this
        // function has already thrown to its caller, with nothing recording or waiting on it.
        // Settling both first means a throw here always means BOTH halves' git work is done.
        const settled = await Promise.allSettled([
          landGreenest(subset.slice(0, mid), `${subLabel}a`, waitForPredecessor, releaseFirst),
          landGreenest(subset.slice(mid), `${subLabel}b`, afterBoth(waitForPredecessor, firstDone)),
        ]);
        const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
        if (rejected) throw rejected.reason;
        [first, second] = (settled as PromiseFulfilledResult<TrainRunResult>[]).map((s) => s.value);
      } else {
        first = await landGreenest(subset.slice(0, mid), `${subLabel}a`, waitForPredecessor);
        second = await landGreenest(subset.slice(mid), `${subLabel}b`, waitForPredecessor);
      }
      return {
        trainRef: attempt.trainRef,
        landed: [...first.landed, ...second.landed],
        dropped: [...attempt.dropped, ...first.dropped, ...second.dropped],
        gateRejected: [...first.gateRejected, ...second.gateRejected],
        sided: [...first.sided, ...second.sided],
        closeFailures: [...first.closeFailures, ...second.closeFailures],
        gateRuns: attempt.gateRuns + first.gateRuns + second.gateRuns,
        attempts: [...attempt.attempts, ...first.attempts, ...second.attempts],
        mergeSha: second.mergeSha ?? first.mergeSha,
        conflictClusters: dedupeConflictClusters([
          ...(attempt.conflictClusters ?? []),
          ...(first.conflictClusters ?? []),
          ...(second.conflictClusters ?? []),
        ]),
        // Only still a whole-batch failure if neither half landed anything.
        ...(first.landed.length + second.landed.length === 0
          ? { gateFailure: attempt.gateFailure }
          : {}),
        // #1203: a cancel that fires WHILE both halves are already gating (the parallel branch)
        // is caught by neither half's OWN pre-attempt check — each had already started before
        // the signal fired — so surface it here from whichever half's `runGate` closure noticed
        // the abort and returned a failed gate. Either half reporting cancelled makes the whole
        // split's result cancelled, since the run as a whole was told to stop.
        ...(first.cancelled || second.cancelled ? { cancelled: true as const } : {}),
      };
    } finally {
      notifyDone?.();
    }
  }

  const result = await landGreenest(members, label);
  // The control arm's run is a real gate run and is counted as one; its verdict rides along so
  // the persisted evidence can say "base red, nothing attributable to members".
  const probe = baseProbe.current;
  return probe
    ? { ...result, gateRuns: result.gateRuns + probe.gateRuns, baseVerdict: probe.verdict }
    : result;
}

/** The live default for `freeVerifySlots` — how many verify chains could start on this box right now. */
function defaultFreeVerifySlots(): number {
  return Math.max(0, verifyChainSemaphoreConcurrency() - verifyChainSemaphoreActive());
}

/** ONE assemble → gate → land → close cycle. The bisect driver above composes these. */
async function runTrainAttempt(args: {
  repoPath: string;
  baseBranch: string;
  members: TrainMember[];
  label: string;
  trainId?: string;
  runGate: TrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  shouldLand?: () => Promise<string | null>;
  isEnvironmentFailure: (message: string) => boolean;
  onAttempt?: (attempt: MergeTrainAttemptDto) => Promise<void>;
  /**
   * #1193 — resolved once it is this attempt's turn to LAND (a no-op when absent, i.e. every
   * caller before #1193). Awaited only immediately before `landMergeTrain`, never before
   * assembly or the gate, so two concurrently-gated halves still verify at the same time —
   * only the git-level landing is serialized.
   */
  waitForLandTurn?: Promise<void>;
  /** #1203 — see `runMergeTrain`'s doc comment; only read here to classify a killed gate. */
  signal?: AbortSignal;
}): Promise<TrainRunResult> {
  const { repoPath, baseBranch, members, label, trainId, runGate, closeMember } = args;

  const asm = await assembleMergeTrain({ repoPath, baseBranch, members, label });
  const closeFailures: TrainRunResult["closeFailures"] = [];
  let gateStartedAt: string | null = null;
  let gateFinishedAt: string | null = null;

  /**
   * #1189: stamp this attempt as one node of the bisect tree and hand it to `onAttempt`
   * BEFORE returning, so the caller can persist it while the driver is still deciding whether
   * to split. Each exit below goes through here; a THROW (base moved, ancestry violation) does
   * not, and the whole train throws with it — there is no verdict to record for that.
   */
  async function finish(result: Omit<TrainRunResult, "attempts" | "conflictClusters">, verdict: MergeTrainAttemptVerdict): Promise<TrainRunResult> {
    const failure = result.landRefused ?? result.gateFailure;
    const record: MergeTrainAttemptDto = {
      label,
      members: members.map((m) => m.workspaceId),
      included: asm.included.map((m) => m.workspaceId),
      // #1193: `result.dropped` (not `asm.dropped`) so a member dropped during the speculative
      // re-assembly after a base move (see below) is still visible on this attempt's node.
      dropped: result.dropped.map((d) => ({
        workspaceId: d.member.workspaceId,
        reason: d.reason,
        ...(d.deferred ? { deferred: true as const } : {}),
      })),
      gateStartedAt,
      gateFinishedAt,
      gateRuns: result.gateRuns > 0 ? 1 : 0,
      verdict,
      ...(verdict !== "landed" && failure ? { failureHead: failure.slice(0, 300) } : {}),
      ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}),
      ...(result.sided.length > 0 ? { sided: result.sided.map((s) => ({ workspaceId: s.member.workspaceId, reason: s.reason.slice(0, 300) })) } : {}),
    };
    if (args.onAttempt) {
      try {
        await args.onAttempt(record);
      } catch (err) {
        console.warn(`[merge-train] could not record attempt ${label} (non-fatal): ${errorMessage(err).slice(0, 200)}`);
      }
    }
    return { ...result, attempts: [record], conflictClusters: asm.conflictClusters };
  }

  // The train ref is scratch state, so its cleanup belongs in a `finally` rather than at each
  // of the three exits. `deleteTrainRef` used to be called on assembly-empty, gate-fail and
  // success — but a THROW from `assertTrainPreservesAncestry` or `landMergeTrain` (base moved
  // under us, ancestry violation) skipped all three, so every failed train left a
  // `refs/kanban/train/q…` branch behind and they accumulated for the life of the repo.
  // `deleteTrainRef` is itself best-effort and never throws, so it cannot mask a real error.
  try {
    if (asm.included.length === 0 || !asm.trainSha) {
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 0, gateFailure: "no members could be assembled onto the train" }, "assembly_empty");
    }

    // Cheap insurance before spending a gate on it: if assembly somehow produced a train that
    // does not contain a member's tip, everything downstream would be wrong.
    await assertTrainPreservesAncestry(repoPath, asm.trainRef, asm.included, baseBranch);

    // #676: hand the gate the members actually INCLUDED in the assembled tree, not the ones
    // requested. A member dropped during assembly (conflict) is not landing, so keying the
    // deferred-install check on the requested set would block the train on a workspace whose
    // code is not in it.
    gateStartedAt = new Date().toISOString();
    const gate = await runGate({ trainRef: asm.trainRef, trainSha: asm.trainSha, included: asm.included, label });
    gateFinishedAt = new Date().toISOString();
    if (!gate.passed) {
      // #1203: the gate itself was killed by the SAME signal a cancel aborts (`runGate`'s own
      // closure passes it into `runSetupScript`) — this failure is the cancel, not a verdict
      // about the code, so it must not be bisected or attributed to any member.
      if (args.signal?.aborted) {
        return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message, cancelled: true }, "red");
      }
      // #1154/#1189: an environment failure is the train's, not a member's — its own leaf kind.
      const verdict: MergeTrainAttemptVerdict = args.isEnvironmentFailure(gate.message) ? "env_failure" : "red";
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: gate.message }, verdict);
    }

    // #1193: wait for an earlier concurrently-gated half to finish its own landing (or decide
    // not to land) before this one so much as re-reads the row — the base only moves under a
    // half that has already had its turn, which is what keeps the #1181 check below and
    // `landMergeTrain`'s base-moved refusal meaningful.
    if (args.waitForLandTurn) await args.waitForLandTurn;

    // #1181: last look before the base changes — a row abandoned during the gate must not land.
    const landRefused = args.shouldLand ? await args.shouldLand() : null;
    if (landRefused) {
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: [], gateRuns: 1, gateFailure: landRefused, landRefused }, "land_refused");
    }

    // #1194: a train review may have attributed a blocking finding to specific members. The
    // assembled ref that was just gated still carries their commits, so it cannot be landed
    // as-is — it must be re-assembled WITHOUT them onto a fresh ref before landing. No re-gate:
    // the combined tree already proved out, and removing a branch's changes is not something
    // the gate needs to re-verify — re-gating would cost exactly the "review once" thrift this
    // feature exists for.
    const sidedIds = new Set((gate.sided ?? []).map((s) => s.workspaceId));
    const sidedMembers: TrainRunResult["sided"] = asm.included
      .filter((m) => sidedIds.has(m.workspaceId))
      .map((member) => ({ member, reason: gate.sided!.find((s) => s.workspaceId === member.workspaceId)!.reason }));
    // #1190: the self-describing landing commit (subject names the parent train + members, body
    // carries the gate evidence, `Merge-Train:` trailer names the row). Same for every landing
    // path below, since each of them lands the same gated evidence.
    const commitEvidence = trainId ? { evidence: { trainId, gateRuns: 1, gateMessage: gate.message } } : {};

    if (sidedIds.size === 0) {
      // #1193: when this attempt was coordinated as part of a concurrent bisect split (it was
      // handed a `waitForLandTurn`), an earlier sibling landing while we waited is an EXPECTED,
      // self-inflicted base move, not the external interference `landMergeTrain`'s throw exists
      // to catch — so speculatively recover from it rather than let the whole train throw.
      // Outside that (no `waitForLandTurn`: a lone attempt, or the ordinary sequential path,
      // where `assembleMergeTrain` always runs against the freshly-current base already), a base
      // move is exactly the anomaly it always was, and falls through to `landMergeTrain`'s own
      // check unchanged.
      //
      // The gate verified `asm.trainSha` (the base sha AT GATE TIME plus these members), not the
      // tree a --no-ff merge into the NEW base would produce, so recovering means re-assembling
      // the SAME already-gated members onto the CURRENT base — deliberately no re-gate, since
      // gating a second time would erase exactly the wall-clock saving this feature exists for —
      // and landing THAT. This is the "speculative" half of speculative bisect: a member that no
      // longer assembles cleanly (a genuine conflict with what just landed) is dropped exactly as
      // an ordinary assembly conflict, falling back to the per-ticket path, rather than landed
      // unverified. (The sided path below re-assembles onto the current base anyway, so it
      // needs no such recovery.)
      let landAsm = asm;
      const additionalDropped: TrainRunResult["dropped"] = [];
      if (args.waitForLandTurn && (await revParse(repoPath, baseBranch)) !== asm.baseSha) {
        landAsm = await assembleMergeTrain({ repoPath, baseBranch, members: asm.included, label });
        additionalDropped.push(...landAsm.dropped);
        if (landAsm.included.length === 0 || !landAsm.trainSha) {
          return await finish(
            {
              trainRef: landAsm.trainRef,
              landed: [],
              dropped: [...asm.dropped, ...additionalDropped],
              closeFailures,
              gateRejected: [],
              sided: [],
              gateRuns: 1,
              gateFailure: "base moved after gating and no member could be re-assembled onto the new base",
            },
            "assembly_empty",
          );
        }
        await assertTrainPreservesAncestry(repoPath, landAsm.trainRef, landAsm.included, baseBranch);
      }

      const { mergeSha } = await landMergeTrain({
        repoPath,
        baseBranch,
        trainRef: landAsm.trainRef,
        // Guaranteed non-null: either `asm.trainSha` (checked at the top of this function) when
        // the base never moved, or `landAsm.trainSha` (checked just above) when it did.
        trainSha: landAsm.trainSha!,
        baseSha: landAsm.baseSha,
        included: landAsm.included,
        label,
        ...commitEvidence,
      });
      // Bookkeeping AFTER the work is safely on the base. A failure here leaves a member merged
      // but not marked — recoverable by the existing done-unmerged/already-merged reconcilers,
      // and reported rather than swallowed.
      for (const member of landAsm.included) {
        try {
          await closeMember(member.workspaceId);
        } catch (err) {
          const reason = errorMessage(err);
          closeFailures.push({ member, reason });
          console.warn(`[merge-train] landed ${member.branch} but could not close its workspace: ${reason.slice(0, 200)}`);
        }
      }
      return await finish({ trainRef: landAsm.trainRef, landed: landAsm.included, dropped: [...asm.dropped, ...additionalDropped], mergeSha, closeFailures, gateRejected: [], sided: [], gateRuns: 1 }, "landed");
    }

    const toLand = asm.included.filter((m) => !sidedIds.has(m.workspaceId));
    if (toLand.length === 0) {
      // Everyone left in this attempt was sided — nothing to land, but every member is
      // attributed, so there is no batch-level failure to blame on anyone else.
      return await finish({ trainRef: asm.trainRef, landed: [], dropped: asm.dropped, closeFailures, gateRejected: [], sided: sidedMembers, gateRuns: 1, gateFailure: "every remaining member was sided by the train review" }, "sided");
    }

    const reassembled = await assembleMergeTrain({ repoPath, baseBranch, members: toLand, label: `${label}-sided` });
    try {
      if (reassembled.included.length === 0 || !reassembled.trainSha) {
        return await finish({
          trainRef: asm.trainRef, landed: [], dropped: [...asm.dropped, ...reassembled.dropped], closeFailures,
          gateRejected: [], sided: sidedMembers, gateRuns: 1,
          gateFailure: "no members could be re-assembled after removing the sided member(s)",
        }, "sided");
      }
      await assertTrainPreservesAncestry(repoPath, reassembled.trainRef, reassembled.included, baseBranch);
      const { mergeSha } = await landMergeTrain({
        repoPath, baseBranch, trainRef: reassembled.trainRef, trainSha: reassembled.trainSha,
        baseSha: reassembled.baseSha, included: reassembled.included,
        label, ...commitEvidence,
      });

      // Bookkeeping AFTER the work is safely on the base. A failure here leaves a member merged
      // but not marked — recoverable by the existing done-unmerged/already-merged reconcilers,
      // and reported rather than swallowed.
      for (const member of reassembled.included) {
        try {
          await closeMember(member.workspaceId);
        } catch (err) {
          const reason = errorMessage(err);
          closeFailures.push({ member, reason });
          console.warn(`[merge-train] landed ${member.branch} but could not close its workspace: ${reason.slice(0, 200)}`);
        }
      }

      return await finish({
        trainRef: asm.trainRef, landed: reassembled.included, dropped: [...asm.dropped, ...reassembled.dropped],
        mergeSha, closeFailures, gateRejected: [], sided: sidedMembers, gateRuns: 1,
      }, "landed");
    } finally {
      await deleteTrainRef(repoPath, reassembled.trainRef);
    }
  } finally {
    await deleteTrainRef(repoPath, asm.trainRef);
  }
}

/** Delete a train ref once its members have been stamped. Best-effort: a leftover ref is harmless. */
export async function deleteTrainRef(repoPath: string, trainRef: string): Promise<void> {
  try {
    await gitExec(["branch", "-D", trainRef], { cwd: repoPath });
  } catch {
    // Best-effort.
  }
}
