import { basename, dirname, join } from "node:path";
import { worktreeDirLeafForBranch } from "@agentic-kanban/shared/lib/git-service";

/**
 * Mutual exclusion for workspace creation, keyed by the WORKTREE DIRECTORY a create is
 * about to provision — #673 item 1, re-keyed and given a TTL in #719, keyed on the full
 * path and given a claim token in #736.
 *
 * `auto-start-claim.ts` (#366) already closes a race between AUTOMATIC starters, but it is
 * issue-scoped and deliberately exempts non-auto-starter creates ("deliberate multi-workspace
 * creation… does NOT restrict"). That left the same-issue race wide open between an automatic
 * starter and a manual `POST /api/workspaces` (or two manual calls) — exactly what #670 hit:
 * the monitor auto-start and a manual create both resolved to the SAME default branch
 * (`suggestBranchName` is deterministic whenever the caller omits an explicit `branch`) and
 * both passed the DB-based "does a live workspace already hold this branch?" read, because the
 * workspace row for a still-provisioning create does not exist for 80s–8+ minutes (see
 * create-job.service.ts). Two rows landed 9s apart sharing one worktree, and both launched an
 * agent into it.
 *
 * ## Why the key is the PATH, not the branch (#719) — and the WHOLE path (#736)
 *
 * #673 keyed this on `(issueId, branch)` and wrote down, as a feature, that two branches of
 * one issue are exempt — the "provider showdown" case #366 carved out. That exemption was the
 * bug. `createWorktree` collapses EVERY branch of issue N to the on-disk leaf `ak-N`
 * (`shortenWorktreeLeaf`, #193), so two branches of one issue are precisely the pair that
 * contends on ONE directory. The guard was keyed on the branch; the contention is on the path.
 *
 * And the contention is destructive, not merely awkward: `createWorktree`'s leftover-cleanup
 * asks "does a LIVE workspace claim this directory?" — which a still-provisioning sibling
 * cannot answer yes to, because its row does not exist yet — so the loser of the race can
 * recursively delete the winner's fresh worktree instead of falling through to the `ak-N-2`
 * alternative path.
 *
 * #719 keyed on `issueId + leaf`, using `issueId` as a stand-in for the repo (an issue belongs
 * to exactly one project, hence one repo). That left one hole open: a create whose EXPLICIT
 * branch names a DIFFERENT issue's number — issue A on `feature/ak-670-x` resolves to the leaf
 * `ak-670` — contended with issue 670's directory without being refused, because the two
 * claims differed in their `issueId` half. #736 closes it by keying on the RESOLVED WORKTREE
 * PATH: `<parent>/.worktrees/<repoDirName>/<leaf>`, with `repoPath` threaded in from
 * `workspace-create.service.ts` (where it is resolved a few lines above the claim, and — this
 * is what makes it possible — held in a synchronous local, so the check-and-set stays
 * `await`-free). `issueId` is now carried for the log line and the 409 only; it is no longer
 * part of the key, which is why cross-issue leaf collisions are now caught.
 *
 * The leaf comes from the SAME function `createWorktree` uses (`worktreeDirLeafForBranch`)
 * rather than being re-implemented here. The `.worktrees/<repoDirName>` prefix is composed
 * here (git-service's `worktreesDirFor` is private), which is a derivation in two places — but
 * a benign one for a KEY: both racing creates run it, so they agree, and where its
 * segment-sanitizing differs from git-service's the direction is over-refusal (two repos whose
 * basenames sanitize to one segment really do share a `.worktrees` subtree). Exporting
 * `worktreesDirFor` would collapse it, and is the right follow-up if that prefix ever grows.
 *
 * Refusing is right for this resource: two creates cannot provision one directory
 * concurrently under any reading. A DELIBERATE second workspace is not blocked, it is
 * SERIALIZED — once the first create finishes the claim is released, and the next create's
 * `createWorktree` sees the directory registered to git and takes the `ak-N-2` alternative
 * path, which is how a sequential provider showdown already worked. #394 co-residency is
 * likewise untouched: it adopts an ALREADY-PROVISIONED worktree, so it never takes a claim.
 *
 * ## TTL, and why a claim must be able to go stale
 *
 * #673 released the claim only in `createWorkspace`'s `finally`, so a create that hung inside
 * `setupWorktree` wedged `409 BRANCH_CREATE_IN_FLIGHT` for the whole lifetime of the server
 * process — a liveness regression traded for the safety one. A claim therefore records WHEN
 * it was taken and is treated as abandoned once older than `CLAIM_TTL_MS`; a later create
 * takes it over and says so in the log.
 *
 * ## The claim token, and what it prevents (#736)
 *
 * A TTL means a claim can change hands, so "release the claim on this key" is not the same
 * request as "release MY claim". #719 released by key alone (the call site tracked a branch
 * string), so a hung create that woke up after its claim was taken over deleted the
 * SUCCESSOR's claim — degrading to #673's own "no claim held" state for the rest of the
 * successor's create. `claimBranchForCreate` therefore returns an opaque
 * {@link BranchCreateClaimToken}, and `releaseBranchForCreate` no-ops when the claim now
 * stored under that path was taken by someone else. The token is also how the call site knows
 * WHICH path it claimed, so the 409 and the release cannot disagree about the resource.
 *
 * ## Durability: in-process only, deliberately
 *
 * This is a `Map`, not a row with a unique constraint, and that is a conscious scope
 * boundary rather than an oversight. Workspace creation for a project always runs in the
 * board's own server process, so in-process exclusion covers every real create path (HTTP,
 * monitor, CLI-through-HTTP, MCP-through-HTTP). The cross-process case
 * `listAbandonedProvisioning` reasons about — "a second board process on another port" — is
 * already served by the DURABLE `workspace_provisioning` marker, which is where a unique
 * constraint belongs if that case ever needs ENFORCING rather than reconciling. Putting one
 * here would mean a migration plus a durable write on the hot create path to guard a case a
 * second board process makes unsafe for many other reasons too.
 */

/**
 * How long a create may hold a claim before a later create may take it over.
 *
 * Sized off the create path's own worst case, not off a round number: single-repo
 * provisioning runs 80s–8+ minutes, and a multi-repo project with per-worktree installs runs
 * into tens of minutes. A TTL below that would let two creates genuinely race on one
 * directory, which is the failure this module exists to prevent — so it is deliberately far
 * longer than a healthy create and only ever fires for a process stuck in `setupWorktree`.
 */
export const CLAIM_TTL_MS = 30 * 60 * 1000;

/** The (repo, branch) a create is about to provision a worktree for. */
export interface BranchCreateTarget {
  /** The LEADING repo's path — the `<parent>/.worktrees/<repoDirName>` the leaf sits under. */
  repoPath: string;
  /** Carried for the log line and the 409 only; deliberately NOT part of the key (#736). */
  issueId: string;
  branch: string;
}

/**
 * Proof that a specific create holds a specific claim. Opaque: pass it back to
 * {@link releaseBranchForCreate}, and read `worktreePath` when reporting the refusal.
 */
export interface BranchCreateClaimToken {
  /** The worktree directory this claim covers — the key, and the resource to name in a 409. */
  readonly worktreePath: string;
  /** Identifies this HOLDER, so a taken-over predecessor cannot release its successor. */
  readonly holderId: string;
}

interface BranchCreateClaim {
  issueId: string;
  /** The branch the claim was taken for — for the log line only; the KEY is the path. */
  branch: string;
  claimedAtMs: number;
  holderId: string;
}

const claims = new Map<string, BranchCreateClaim>();
let holderCounter = 0;

/**
 * The worktree directory a create for this (repo, branch) will provision, as a claim key.
 *
 * Every branch of issue N collapses to the same leaf, so every branch of issue N collapses
 * to the same key — which is the whole point of #719 — and so does another issue's branch
 * that happens to name N, which is the point of #736.
 */
export function worktreeClaimPath(repoPath: string, branch: string): string {
  return join(dirname(repoPath), ".worktrees", basename(repoPath), worktreeDirLeafForBranch(branch));
}

/**
 * Atomically claim the worktree directory a create is about to provision. Returns a token on
 * success, or `null` when another create is already provisioning that directory.
 *
 * Synchronous and `await`-free on purpose — see the module header.
 */
export function claimBranchForCreate(
  target: BranchCreateTarget,
  opts: { nowMs?: number; ttlMs?: number } = {},
): BranchCreateClaimToken | null {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? CLAIM_TTL_MS;
  const key = worktreeClaimPath(target.repoPath, target.branch);
  const held = claims.get(key);
  if (held) {
    const ageMs = nowMs - held.claimedAtMs;
    if (ageMs < ttlMs) return null;
    console.warn(
      `[workspaces] taking over an abandoned worktree-create claim on "${key}" — held for `
        + `${Math.round(ageMs / 1000)}s (issue ${held.issueId}, branch "${held.branch}", `
        + `TTL ${Math.round(ttlMs / 1000)}s). The create that took it never reached its `
        + `release, so it is assumed dead.`,
    );
  }
  const holderId = `${++holderCounter}`;
  claims.set(key, { issueId: target.issueId, branch: target.branch, claimedAtMs: nowMs, holderId });
  return { worktreePath: key, holderId };
}

/**
 * Release a claim taken by {@link claimBranchForCreate}. Safe to call with `null` (never
 * claimed), and a NO-OP when the claim on that path has since been taken over by a later
 * create — releasing the successor's claim is the #736 hole this token closes.
 */
export function releaseBranchForCreate(token: BranchCreateClaimToken | null | undefined): void {
  if (!token) return;
  const held = claims.get(token.worktreePath);
  if (!held || held.holderId !== token.holderId) return;
  claims.delete(token.worktreePath);
}

/** Is a create currently provisioning the worktree this (repo, branch) resolves to? */
export function isBranchCreateClaimed(
  target: Pick<BranchCreateTarget, "repoPath" | "branch">,
  opts: { nowMs?: number; ttlMs?: number } = {},
): boolean {
  const held = claims.get(worktreeClaimPath(target.repoPath, target.branch));
  if (!held) return false;
  return (opts.nowMs ?? Date.now()) - held.claimedAtMs < (opts.ttlMs ?? CLAIM_TTL_MS);
}

/** Test seam: drop all tracked claims. */
export function resetBranchCreateClaims(): void {
  claims.clear();
}
