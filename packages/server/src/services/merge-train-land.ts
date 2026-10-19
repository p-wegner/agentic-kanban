// Trailer + commit message + landing of a merge train, split out of merge-train.service.ts (#1605); re-exported there.
import { getCurrentBranch, getUncommittedTrackedChanges, isAncestor, mergeBranch, revParse } from "@agentic-kanban/shared/lib/git-service";
import { assertTrainPreservesAncestry, parentTrainLabel, trainRefName, type TrainMember } from "./merge-train-assembly.js";

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

export interface DirtyBaseWaitOptions {
  /** Give up (and throw) after this long. Default 10 min. */
  maxWaitMs?: number;
  pollMs?: number;
  /** One ATTENTION line after this long. Default 2 min. */
  attentionAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * #1621 - a dirty main checkout at landing time is an infra hold, not a verdict on the train:
 * wait (bounded) for it to clear instead of letting `mergeBranch` throw and the green train be
 * discarded. Line-ending-only changes never count (see `getUncommittedTrackedChanges`).
 */
async function waitForCleanBase(repoPath: string, baseBranch: string, opts: DirtyBaseWaitOptions = {}): Promise<void> {
  const { maxWaitMs = 10 * 60_000, pollMs = 15_000, attentionAfterMs = 2 * 60_000 } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.log(`[merge-train] ${m}`));
  if ((await getCurrentBranch(repoPath).catch(() => "")) !== baseBranch) return;
  let waited = 0;
  let announced = false;
  for (;;) {
    const dirty = await getUncommittedTrackedChanges(repoPath);
    if (dirty.length === 0) return;
    const names = dirty.slice(0, 5).map((l) => l.replace(/^\S+\s+/, "")).join(", ");
    if (waited >= maxWaitMs) {
      throw new Error(`landing held: main checkout has uncommitted ${names} (waited ${Math.round(waited / 1000)}s); the train ref is kept`);
    }
    if (!announced && waited >= attentionAfterMs) {
      announced = true;
      log(`ATTENTION landing held: main checkout has uncommitted ${names}`);
    }
    await sleep(pollMs);
    waited += pollMs;
  }
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
  dirtyBase?: DirtyBaseWaitOptions;
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
  await waitForCleanBase(repoPath, baseBranch, args.dirtyBase);

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
