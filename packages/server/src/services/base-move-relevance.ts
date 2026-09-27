/**
 * Can a base move that happened DURING a gate run change that gate's verdict? (#243 refinement)
 *
 * The #243 protocol pins the tips before a gate, re-reads them after, and discards a PASS when
 * either moved: the merge result is no longer the tree that was tested. That is right for a
 * branch move and for most base moves, and wrong for the commonest base move on this board. On
 * 2026-09-26 three Bullseye saves each committed only `scripts/board-monitor/objective.md`
 * (`chore(monitor): sync objective.md from Strategy Bullseye save`) and threw away three passed
 * gates of 2463 s, 1489 s and 1508 s.
 *
 * {@link classifyBaseMove} is the ONE decision: the files the base move touched in, keep or
 * discard out. It keeps a verdict only when EVERY moved path is on a closed allowlist of paths no
 * gate input reads, and the branch itself touches none of them. Everything else discards, exactly
 * as before, and so does every failure to compute the file lists (fail closed).
 *
 * The allowlist is closed on purpose, like every set in `docs-only-diff.ts` (#240, #642). "All
 * markdown" would be wrong here: the `@gate:always-run` guard suites read CLAUDE.md, skill files,
 * `docs/env-vars.md`, `docs/worker-fleet.md`, `docs/integration-risk-ladder.md`, the decision
 * records and more as INPUT, so a doc change can turn a guard red. Each entry below was checked
 * against the guard suites, and `base-move-relevance-allowlist-ratchet.test.ts` fails when a
 * guard suite starts naming one.
 *
 * `scripts/board-monitor/objective.md` has one guard reader,
 * `objective-capacity-hold-ratchet.test.ts` (#1029). Its marker is `when:` that file, so a gate
 * for a branch that does not touch objective.md never runs it, and the branch-overlap rule below
 * discards whenever the branch does touch it. Its verdict depends on objective.md alone, so a red
 * there is the base's own state, which base-health attribution (#491) covers; it says nothing
 * about the branch.
 *
 * Callers: `runGateWithEvidence` (every solo gate: pre-lock merge, review-exit, both monitor merge
 * paths). The merge train refuses to land when its base moved (`landMergeTrain`); it can call
 * {@link assessBaseMove} with the train ref as `branchSha` to make the same decision.
 */
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

/** Exact repo-relative paths no gate input reads. */
export const VERDICT_NEUTRAL_FILES: readonly string[] = [
  "scripts/board-monitor/objective.md",
  "CONTINUE.md",
  "BACKLOG.md",
  "docs/state.md",
  "docs/diary.md",
];

/** Doc directories no gate input reads; only {@link NEUTRAL_DOC_EXTENSIONS} files under them count. */
export const VERDICT_NEUTRAL_DOC_DIRS: readonly string[] = [
  "docs/proposals/",
  "docs/analysis/",
  "docs/archive/",
  "docs/learnings/",
  "docs/ideas/",
  "docs/plans/",
];

/** Documentation and image extensions. No `.json`/`.yaml`: `docs/**` holds data code reads (#642). */
const NEUTRAL_DOC_EXTENSIONS = /\.(md|png|jpe?g|gif|svg|webp)$/i;

/** True when `path` is on the allowlist. Paths are git's repo-relative form; `\` is normalized. */
export function isVerdictNeutralPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (VERDICT_NEUTRAL_FILES.includes(normalized)) return true;
  return VERDICT_NEUTRAL_DOC_DIRS.some((dir) => normalized.startsWith(dir))
    && NEUTRAL_DOC_EXTENSIONS.test(normalized)
    // A path git had to quote (`"docs/…\303…"`) or one climbing out of the dir is not ours to judge.
    && !normalized.includes("/../") && !normalized.startsWith("\"");
}

export interface BaseMoveDecision {
  keep: boolean;
  /** One line for the log: which paths decided it. */
  reason: string;
}

function listPaths(paths: readonly string[], max = 5): string {
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown} (+${paths.length - max} more)` : shown;
}

/**
 * Keep or discard a PASSED verdict whose base moved during the run. Pure.
 *
 * - `movedPaths`: files changed between the pinned base sha and the new one (`null` = unknown).
 * - `branchPaths`: files the branch changes against the pinned base (`null` = unknown).
 *
 * Keeps only when both lists are known, `movedPaths` is non-empty, every moved path is
 * verdict-neutral, and the branch touches none of them (a file both sides changed merges into
 * content the gate never saw). Anything else discards.
 */
export function classifyBaseMove(args: {
  movedPaths: readonly string[] | null;
  branchPaths: readonly string[] | null;
}): BaseMoveDecision {
  const { movedPaths, branchPaths } = args;
  if (movedPaths === null) return { keep: false, reason: "could not list the files the base move changed" };
  if (movedPaths.length === 0) return { keep: false, reason: "the base move changed no files git could list" };
  const relevant = movedPaths.filter((p) => !isVerdictNeutralPath(p));
  if (relevant.length > 0) return { keep: false, reason: `the base move changed gate inputs: ${listPaths(relevant)}` };
  if (branchPaths === null) return { keep: false, reason: "could not list the files the branch changes" };
  const branchSet = new Set(branchPaths.map((p) => p.replace(/\\/g, "/")));
  const overlap = movedPaths.filter((p) => branchSet.has(p.replace(/\\/g, "/")));
  if (overlap.length > 0) return { keep: false, reason: `the branch also changes ${listPaths(overlap)}` };
  return { keep: true, reason: `the base move changed only verdict-neutral paths: ${listPaths(movedPaths)}` };
}

/**
 * `git diff --name-only --no-renames <range>`; null when git cannot answer. `--no-renames` is
 * required: with rename detection on, a code file renamed into `docs/proposals/` lists only its
 * NEW path, which the allowlist would accept.
 */
export async function readChangedPaths(cwd: string, range: string[]): Promise<string[] | null> {
  try {
    const res = await gitExec(["diff", "--name-only", "--no-renames", ...range], { cwd });
    if (!execSucceeded(res)) return null;
    return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** Files changed between two base tips. */
export function readBaseMoveFiles(cwd: string, baseBefore: string, baseAfter: string): Promise<string[] | null> {
  return readChangedPaths(cwd, [baseBefore, baseAfter]);
}

/** Files the branch changes relative to its merge-base with the pinned base tip. */
export function readBranchFiles(cwd: string, baseBefore: string, branchSha: string): Promise<string[] | null> {
  return readChangedPaths(cwd, [`${baseBefore}...${branchSha}`]);
}

export interface BaseMoveAssessment extends BaseMoveDecision {
  /** The moved paths when known, for logging and the discard record. */
  movedPaths: string[] | null;
}

/**
 * Read both file lists and classify. Never throws: any read failure becomes a discard.
 * Readers are injectable so a test needs no repo.
 */
export async function assessBaseMove(args: {
  cwd: string | null | undefined;
  baseBefore: string;
  baseAfter: string;
  branchSha: string | null | undefined;
  readMoved?: (cwd: string, before: string, after: string) => Promise<string[] | null>;
  readBranch?: (cwd: string, before: string, branchSha: string) => Promise<string[] | null>;
}): Promise<BaseMoveAssessment> {
  const { cwd, baseBefore, baseAfter, branchSha } = args;
  if (!cwd) return { keep: false, reason: "the workspace has no worktree to diff in", movedPaths: null };
  const movedPaths = await (args.readMoved ?? readBaseMoveFiles)(cwd, baseBefore, baseAfter).catch(() => null);
  const branchPaths = branchSha
    ? await (args.readBranch ?? readBranchFiles)(cwd, baseBefore, branchSha).catch(() => null)
    : null;
  return { ...classifyBaseMove({ movedPaths, branchPaths }), movedPaths };
}
