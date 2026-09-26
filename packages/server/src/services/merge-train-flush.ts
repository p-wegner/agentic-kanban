/**
 * Flush train mode (#1247, decision 020 part 2): the merge train run in a mode that trades
 * per-change proof for throughput, the way `flow` (decision 019) trades it for the release.
 *
 * A normal train gates the assembled tree with the project's full configured verify command and
 * bisects a red batch to attribute the failure to a member. A flush does neither: every ready
 * branch rides (no `trainMaxSize` cap — the caller passes the whole ready set), the gate is
 * `check:arch && typecheck` ONLY (no test run, no impact selection), and a red gate is NOT
 * bisected — `bisectOnFailure: false` — because there is no cheap attribution question to ask;
 * the suite that would answer it is exactly what flush mode skips. Typecheck stays mandatory: a
 * non-compiling master breaks every builder worktree, not just the release the "arch+typecheck
 * only" phrase might suggest is the only thing at stake.
 *
 * Sidings stay ACTIVE and unchanged: `assembleMergeTrain`/`recordTrainSidingDrop` operate on
 * `runMergeTrain`'s own `dropped` list regardless of the gate or bisect knobs, so a member that
 * cannot even be assembled (a real conflict, not a gate failure) is sided with a comment and
 * never blocks the rest of the flush. This module does not touch that path — it lives in
 * `merge-queue-train.ts`'s post-`runMergeTrain` handling, which a flush caller reuses as-is.
 *
 * The landing merge commit is tagged `flush/<date>-N` (mirrors `scripts/promote.mjs`'s
 * `stable-<date>` tagging for the rc, decision 019's precedent) so a later heal pass
 * (#1234/#1239/#1249) can find exactly what a flush landed without re-deriving it from the
 * `Merge-Train:` trailer. The ledger row for a flush gate outcome carries `source: "flush"`
 * (composed the same way `recordVerifyGateOutcome`/`recordBaseSweepOutcome` compose `"ci"`/
 * `"base-sweep"`) so the miss-rate join (#1234) counts a flush red SEPARATELY from an
 * impact-selection miss — a flush miss says nothing about the selector, since no selection ran.
 */
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { RiskPosture, RiskPostureLevel } from "@agentic-kanban/shared/types";
import { trainDateStamp } from "./merge-train-assembly.js";
import { runMergeTrain, type TrainGate, type TrainRunResult } from "./merge-train.service.js";
import type { TrainMember } from "./merge-train-assembly.js";

/** The ledger `source` value a flush's gate outcome must carry (#1234). */
export const FLUSH_LEDGER_SOURCE = "flush";

/**
 * Risk postures that MAY flush (decision 020 item 5). `strict` and `standard` refuse: both
 * promise a green master (their `redBasePolicy` is `block`), and a flush's whole point is
 * landing a batch the full gate never proved — exactly what those two rungs exist to prevent.
 * `fast`/`sprint`/`iterate`/`flow` all already resolve a non-`block` `redBasePolicy`, which is
 * what keeps `resolveBaseRedVeto` from holding the departure window after a flush lands red
 * (see the module doc on veto non-interference below) — the flush-eligible set and the
 * veto-softened set are the same set BY CONSTRUCTION, not by a second rule that could drift.
 */
const FLUSH_ALLOWED_LEVELS: ReadonlySet<RiskPostureLevel> = new Set(["fast", "sprint", "iterate", "flow"]);

export interface FlushRefusal {
  reason: string;
}

/**
 * Pure gate: may this posture flush? `null` means yes. Takes the LEVEL, not the whole
 * `RiskPosture`, so a caller that only has the level (a CLI dry-run, a pref-parsing test) does
 * not need to resolve a full posture struct first.
 */
export function isFlushAllowedForLevel(level: RiskPostureLevel): FlushRefusal | null {
  if (FLUSH_ALLOWED_LEVELS.has(level)) return null;
  return {
    reason:
      `risk posture '${level}' refuses a flush — 'strict' and 'standard' promise a green master ` +
      `(redBasePolicy 'block'); flush is allowed under 'fast', 'sprint', 'iterate' and 'flow'`,
  };
}

/** As above, from a resolved posture — the form most callers already have on hand. */
export function isFlushAllowedForPosture(posture: RiskPosture): FlushRefusal | null {
  return isFlushAllowedForLevel(posture.level);
}

/**
 * The tag name for a landed flush, `flush/<date>-N` — mirrors `formatTrainLabel`'s
 * `train/<date>-NN` shape but is deliberately a SEPARATE sequence: a project may run several
 * ordinary trains between flushes, and the tag exists to be found independently of how many
 * trains happened in between (a `git tag --list 'flush/<date>-*'` must not skip numbers because
 * an ordinary train used one).
 */
export function formatFlushTag(dateStamp: string, seq: number): string {
  return `flush/${dateStamp}-${seq}`;
}

/**
 * Create the `flush/<date>-N` tag at `sha`, mirroring `scripts/promote.mjs`'s `stable-<date>`
 * tagging of a green rc (decision 019's precedent — the first git-tag use in this area). Throws
 * on failure: an untagged flush landing is silently unfindable by the heal machinery, so a
 * caller must know rather than log-and-continue.
 */
export async function tagFlushLanding(repoPath: string, tag: string, sha: string): Promise<void> {
  await gitExecOrThrow(["tag", tag, sha], { cwd: repoPath });
}

/**
 * The next `flush/<date>-N` sequence number for today, given the tags a caller already listed
 * (`git tag --list 'flush/<date>-*'`) — kept pure so the sequence logic is testable without a
 * repo. `existingTags` may contain tags of any shape; only ones matching `flush/<date>-<n>`
 * count.
 */
export function nextFlushSeq(dateStamp: string, existingTags: string[]): number {
  const prefix = `flush/${dateStamp}-`;
  let max = 0;
  for (const t of existingTags) {
    if (!t.startsWith(prefix)) continue;
    const n = Number.parseInt(t.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * The required message shape (decision 020 item 4): never a bare "passed" — every flush gate
 * message and train row names the mode, how many branches landed, what the gate WAS (never
 * "the same as usual"), and where the deferred full suite will run.
 */
export function formatFlushMessage(args: {
  landedCount: number;
  healTarget: string;
}): string {
  return `FLUSH: ${args.landedCount} branches landed, gate = arch + typecheck, suite deferred to ${args.healTarget}`;
}

/** The `TrainGate` flush mode must run: `check:arch && typecheck`, no test run, no selection. */
export type FlushTrainGate = TrainGate;

export interface RunFlushTrainArgs {
  repoPath: string;
  baseBranch: string;
  /** Every ready-for-merge member, honouring the conflict-graph ordering — no size cap (item 1). */
  members: TrainMember[];
  label: string;
  trainId?: string;
  /** Must run ONLY `check:arch && typecheck` — never the project's full/impact/scoped gate. */
  runGate: FlushTrainGate;
  closeMember: (workspaceId: string) => Promise<void>;
  /** Where the suite deferred by this flush will run — `docs/decisions/020...`'s heal target (#1249). */
  healTarget: string;
  /** Existing `flush/<dateStamp>-*` tags, for `nextFlushSeq` — a caller-supplied `git tag --list` read. */
  existingFlushTags: string[];
  now?: string;
  onAttempt?: Parameters<typeof runMergeTrain>[0]["onAttempt"];
  signal?: AbortSignal;
}

export interface FlushTrainResult {
  run: TrainRunResult;
  /** Set only when the run landed something — nothing to tag on a fully red flush. */
  tag?: string;
  message: string;
  /** The ledger `source` a caller recording this flush's gate outcome must pass. */
  ledgerSource: typeof FLUSH_LEDGER_SOURCE;
}

/**
 * Run a train in FLUSH mode and tag the landing (decision 020 items 1-4).
 *
 * Deliberately thin: `runMergeTrain` already owns assembly (no cap here — pass the whole ready
 * set), sidings (unconditional on `dropped`), and landing. This function adds only what flush
 * changes: `bisectOnFailure: false` (item 2 — no bisect arm; blame comes later from the heal
 * ticket range, not from a search this mode has no suite to run), the post-land tag (item 3),
 * and the required message shape (item 4). The gate ITSELF (arch+typecheck only, `KANBAN_TEST_GUARDS`
 * off, no impact selection) is the CALLER's `runGate` — this function does not know or enforce
 * what commands it runs, the same separation `runMergeTrain` already has.
 *
 * Item 5 (refusal under `strict`/`standard`, and the base-red veto never holding a flush) is
 * NOT re-implemented here: `isFlushAllowedForPosture` is the refusal gate a caller checks before
 * ever calling this function, and the veto's non-hold falls out of `resolveBaseRedVeto` already
 * returning null for every posture this function may run under (see that gate's doc comment) —
 * there is no separate "bypass the veto for a flush" branch to get wrong.
 */
export async function runFlushTrain(args: RunFlushTrainArgs): Promise<FlushTrainResult> {
  const { repoPath, baseBranch, members, label, trainId, runGate, closeMember, healTarget, existingFlushTags, now, onAttempt, signal } = args;

  const run = await runMergeTrain({
    repoPath,
    baseBranch,
    members,
    label,
    trainId,
    runGate,
    closeMember,
    // Item 2: no bisect arm. A red gate rejects the WHOLE flush attribution-free (nobody is
    // added to `gateRejected` for a batch > 1 — see `runMergeTrain`'s `!bisect` branch), which is
    // correct here: there is no suite run to attribute a failure to any one member.
    bisectOnFailure: false,
    onAttempt,
    signal,
  });

  const dateStamp = trainDateStamp(now);
  let tag: string | undefined;
  if (run.landed.length > 0 && run.mergeSha) {
    const seq = nextFlushSeq(dateStamp, existingFlushTags);
    tag = formatFlushTag(dateStamp, seq);
    await tagFlushLanding(repoPath, tag, run.mergeSha);
  }

  const message = formatFlushMessage({ landedCount: run.landed.length, healTarget });
  return { run, tag, message, ledgerSource: FLUSH_LEDGER_SOURCE };
}
