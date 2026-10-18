import { isAncestor, mergeBranch, revParse } from "@agentic-kanban/shared/lib/git-service";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MergeTrainAttemptDto, MergeTrainAttemptVerdict, MergeTrainBaseVerdict } from "@agentic-kanban/shared/types";
import type { MergeTrainRedStrategy } from "@agentic-kanban/shared/lib/merge-train-red-strategy";
import { verifyChainSemaphoreActive, verifyChainSemaphoreConcurrency } from "./verify-chain-semaphore.js";
import {
  assembleMergeTrain, assertTrainPreservesAncestry, dedupeConflictClusters, formatTrainLabel, parentTrainLabel, trainDateStamp, trainRefName,
  type ConflictCluster, type DroppedTrainMember, type TrainAssemblyResult, type TrainMember,
} from "./merge-train-assembly.js";
import { combineHeldBackRegate, decideAttributedOwners, decideSuiteOwnerShortcut, formatSuiteOwnerReason } from "./merge-train-suite-owner.js";

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

import { runTrainAttempt } from "./merge-train-attempt.js"; export { deleteTrainRef } from "./merge-train-base-move.js";
import { landMergeTrain } from "./merge-train-land.js"; export * from "./merge-train-land.js";
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
  gateRejected: Array<{ member: TrainMember; reason: string; /** #1298 — the suites that attributed it, for the builder turn. */ failedSuites?: string[] }>;
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
   * #1413 — the gate was INCONCLUSIVE (watchdog kill / timeout / held), so nothing is red: no
   * member is attributed, no bisect ran, no fix agent was spawned. The caller re-gates later.
   */
  inconclusive?: true;
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
  /** The suites a red gate named, repo-relative; absent on a green run or when none were named. */
  failedSuites?: string[];
  /** #1277 — the red-handling strategy the train ran under, for the persisted evidence. */
  redStrategy?: MergeTrainRedStrategy;
  /** #1577 — owners held back by the single attributed regate; `summary` is the train row's text. */
  heldBack?: { members: string[]; suites: string[]; summary: string };
}

/**
 * The gate port. `sided` (#1194) is set when a train-scoped review ran beside the gate and
 * attributed a blocking finding to specific members. Only meaningful when `passed` is true: a
 * review finding pulls its member into a siding, it does not fail the gate for everyone else.
 */
/** An assembly dropped these members from `trainRef` (built on `tipSha`); see `runMergeTrain`'s `onDropped`. */
export type OnTrainDropped = (dropped: DroppedTrainMember[], at: { trainRef: string; tipSha: string }) => Promise<void>;

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
  /** On a red run, the suites the gate named (repo-relative), for the suite-owner shortcut. */
  failedSuites?: string[];
  /**
   * #1277 — set when a fix agent ran in the gate's worktree after a red. `attempt` is its row
   * (persisted beside the bisect rows); `fixedTrainSha` is set only when the re-gate on the fixed
   * tree passed, and is then the tip of `trainRef` that must land. A red `passed: false` result
   * with this set carries the RE-GATE's message: the failure the fallback should reason about.
   */
  agentFix?: { attempt: MergeTrainAttemptDto; fixedTrainSha?: string };
  /**
   * #1413 — the gate did not reach a verdict about the code (no-progress watchdog kill, wall-clock
   * timeout, cancelled/held run). Never bisected, never fixed, never attributed: the train is
   * simply retried later.
   */
  inconclusive?: boolean;
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
   * Called right after an attempt's assembly drops members, BEFORE its gate runs, so a member
   * that conflicts with the base is sent back to its builder at once rather than after the
   * whole gate and bisect (or never, when the job dies first). Best-effort: a throw is logged.
   */
  onDropped?: OnTrainDropped;
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
  /** #1572 — the shepherd's incremental assembly for the WHOLE train (default: ref-only); bisect halves get the default. */
  assemble?: typeof assembleMergeTrain;
  /**
   * #1277 — the project's red-handling strategy. The fix agent itself runs inside `runGate` (it
   * needs the gate's installed worktree); this only decides what happens AFTER it: under
   * `agent-fix` a red root attempt is final (no control arm, no bisect), otherwise the search
   * proceeds as before. Absent = `bisect`, today's behaviour. Echoed on the result.
   */
  redStrategy?: MergeTrainRedStrategy;
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
   * branches moving past a bad one. Before halving, a red whose named suites all belong to ONE
   * member rejects that member and re-gates the rest once (`merge-train-suite-owner.ts`;
   * observed on `train/2026-09-27-10`, which bisected over a suite only #1261 added).
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
      // #1413: an inconclusive gate (watchdog kill, timeout, held) says nothing about the code —
      // halving would only re-gate on the same wedged host and then blame a member for it.
      if (attempt.inconclusive) return attempt;
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
      // #1277: `agent-fix` means the fix agent's red IS the verdict — an operator who picked it
      // wants a hard failure on a second red, not a bisect behind their back.
      if (args.redStrategy === "agent-fix" && subLabel === label) {
        // #1577: ATTRIBUTED failures regate ONCE without their owners (label `${label}r` skips the
        // fix agent) and the rest land; never a bisect, an unattributed red holds as before.
        const attributed = decideAttributedOwners(attempt.failedSuites, subset.filter((m) => !attempt.dropped.some((d) => d.member.workspaceId === m.workspaceId)));
        if (!attributed) return attempt;
        const rest = await runTrainAttempt({ ...args, members: attributed.innocent, label: `${subLabel}r`, isEnvironmentFailure, waitForLandTurn: waitForPredecessor });
        return combineHeldBackRegate(attempt, rest, attributed);
      }
      // Suite-owner shortcut (`merge-train-suite-owner.ts`): every failing suite belongs to one
      // included member, so reject it and re-gate the rest once instead of control arm + halving.
      const aboard = subset.filter((m) => !attempt.dropped.some((d) => d.member.workspaceId === m.workspaceId));
      const shortcut = bisect && subset.length > 1 ? decideSuiteOwnerShortcut(attempt.failedSuites, aboard) : null;
      if (shortcut) {
        const rest = await landGreenest(subset.filter((m) => m.workspaceId !== shortcut.owner.workspaceId), `${subLabel}r`, waitForPredecessor);
        return {
          trainRef: attempt.trainRef,
          landed: rest.landed,
          dropped: [...attempt.dropped, ...rest.dropped],
          gateRejected: [{ member: shortcut.owner, reason: formatSuiteOwnerReason(shortcut.suites, attempt.gateFailure), failedSuites: shortcut.suites }, ...rest.gateRejected],
          sided: rest.sided,
          closeFailures: rest.closeFailures,
          gateRuns: attempt.gateRuns + rest.gateRuns,
          attempts: [...attempt.attempts, ...rest.attempts],
          mergeSha: rest.mergeSha,
          conflictClusters: dedupeConflictClusters([...(attempt.conflictClusters ?? []), ...(rest.conflictClusters ?? [])]),
          ...(rest.landed.length === 0 ? { gateFailure: attempt.gateFailure } : {}),
          ...(rest.cancelled ? { cancelled: true as const } : {}),
        };
      }
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
            ? [{ member: subset[0], reason: attempt.gateFailure, ...(attempt.failedSuites?.length ? { failedSuites: attempt.failedSuites } : {}) }]
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
        ...(first.landed.length + second.landed.length === 0 && (first.inconclusive || second.inconclusive) ? { inconclusive: true as const } : {}),
      };
    } finally {
      notifyDone?.();
    }
  }

  const result = await landGreenest(members, label);
  // The control arm's run is a real gate run and is counted as one; its verdict rides along so
  // the persisted evidence can say "base red, nothing attributable to members".
  const probe = baseProbe.current;
  const withProbe = probe
    ? { ...result, gateRuns: result.gateRuns + probe.gateRuns, baseVerdict: probe.verdict }
    : result;
  return args.redStrategy ? { ...withProbe, redStrategy: args.redStrategy } : withProbe;
}

/** The live default for `freeVerifySlots` — how many verify chains could start on this box right now. */
function defaultFreeVerifySlots(): number {
  return Math.max(0, verifyChainSemaphoreConcurrency() - verifyChainSemaphoreActive());
}

