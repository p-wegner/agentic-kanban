/**
 * #1727 — carry a shepherd's fix commits across an INCONCLUSIVE train.
 *
 * An inconclusive gate (worker gone, watchdog kill) abandons the train, and the retry re-forms it
 * from the members' own branches - so a fix commit that exists only on the abandoned train branch
 * is lost and the retry goes red on the same guards and pays for another fix agent. The fix is
 * pinned under `refs/kanban/train-carry/<member-set key>/{base,tip}` (the tree the fix started
 * from, and the fixed tip) and re-applied to the re-formed train as ONE commit via a three-way
 * `merge-tree`, so it survives a moved base and needs no worktree. A conflict skips the carry
 * (logged); the retry then simply gates uncarried.
 */
import { createHash } from "node:crypto";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

const CARRY_PREFIX = "refs/kanban/train-carry";

/** Stable key of a member set: the same members, in any order, carry the same fix. */
export function carryKey(memberWorkspaceIds: readonly string[]): string {
  return createHash("sha1").update([...memberWorkspaceIds].sort().join("|")).digest("hex").slice(0, 16);
}

export interface CarriedFix { baseSha: string; tipSha: string }

async function describeCommits(repoPath: string, baseSha: string, tipSha: string): Promise<string> {
  const r = await gitExec(["log", "--format=%h %s", "--no-merges", `${baseSha}..${tipSha}`], { cwd: repoPath });
  const lines = execSucceeded(r) ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  return lines.length > 0 ? lines.map((l) => l.slice(0, 100)).join("; ") : tipSha.slice(0, 7);
}

/** Pin the fix (`baseSha..tipSha`) for this member set. Best effort; returns the log line or null. */
export async function pinCarriedFix(args: { repoPath: string; memberWorkspaceIds: readonly string[]; label: string } & CarriedFix): Promise<string | null> {
  const key = carryKey(args.memberWorkspaceIds);
  const base = await gitExec(["update-ref", `${CARRY_PREFIX}/${key}/base`, args.baseSha], { cwd: args.repoPath });
  const tip = await gitExec(["update-ref", `${CARRY_PREFIX}/${key}/tip`, args.tipSha], { cwd: args.repoPath });
  if (!execSucceeded(base) || !execSucceeded(tip)) return null;
  return `${args.label}: gate inconclusive after a shepherd fix - pinned fix commit(s) for the retry: ${await describeCommits(args.repoPath, args.baseSha, args.tipSha)}`;
}

export async function readCarriedFix(repoPath: string, memberWorkspaceIds: readonly string[]): Promise<CarriedFix | null> {
  const key = carryKey(memberWorkspaceIds);
  const base = await gitExec(["rev-parse", "--verify", "-q", `${CARRY_PREFIX}/${key}/base`], { cwd: repoPath });
  const tip = await gitExec(["rev-parse", "--verify", "-q", `${CARRY_PREFIX}/${key}/tip`], { cwd: repoPath });
  if (!execSucceeded(base) || !execSucceeded(tip)) return null;
  return { baseSha: base.stdout.trim(), tipSha: tip.stdout.trim() };
}

/** Drop the pin once the members have landed. */
export async function clearCarriedFix(repoPath: string, memberWorkspaceIds: readonly string[]): Promise<void> {
  const key = carryKey(memberWorkspaceIds);
  await gitExec(["update-ref", "-d", `${CARRY_PREFIX}/${key}/base`], { cwd: repoPath });
  await gitExec(["update-ref", "-d", `${CARRY_PREFIX}/${key}/tip`], { cwd: repoPath });
}

/** Per-train-job carry bookkeeping: the sha the train had BEFORE a carry was applied, if one was. */
export interface CarryState { preCarrySha?: string }

/**
 * Wrap the whole-train `assemble` so a carried fix is re-applied right after assembly (bisect
 * halves are left alone). `state.preCarrySha` is what a further inconclusive gate must pin as its
 * base, so a second retry still carries the first fix as well as any new one.
 */
export function withCarriedFix<A extends { repoPath: string; label: string; members: ReadonlyArray<{ workspaceId: string }> }, R extends { trainRef: string; trainSha: string | null }>(
  assemble: (a: A) => Promise<R>,
  rootLabel: string,
  state: CarryState,
): (a: A) => Promise<R> {
  return async (a) => {
    const res = await assemble(a);
    if (a.label !== rootLabel || !res.trainSha) return res;
    const carried = await readCarriedFix(a.repoPath, a.members.map((m) => m.workspaceId));
    if (!carried) return res;
    const applied = await applyCarriedFix({ repoPath: a.repoPath, trainRef: res.trainRef, trainSha: res.trainSha, label: a.label, carried });
    console.log(`[merge-train] ${applied.log}`);
    if (!applied.applied) return res;
    state.preCarrySha = applied.preCarrySha;
    return { ...res, trainSha: applied.newSha };
  };
}

export type ApplyCarriedFixResult =
  | { applied: true; newSha: string; preCarrySha: string; log: string }
  | { applied: false; log: string };

/**
 * Re-apply the carried fix on top of the assembled train ref (a branch name), advancing it by one
 * commit. Never throws.
 */
export async function applyCarriedFix(args: { repoPath: string; trainRef: string; trainSha: string; label: string; carried: CarriedFix }): Promise<ApplyCarriedFixResult> {
  const { repoPath, trainRef, trainSha, label, carried } = args;
  const commits = await describeCommits(repoPath, carried.baseSha, carried.tipSha);
  try {
    const merged = await gitExec(["merge-tree", "--write-tree", `--merge-base=${carried.baseSha}`, trainSha, carried.tipSha], { cwd: repoPath });
    if (!execSucceeded(merged)) return { applied: false, log: `${label}: carried shepherd fix (${commits}) does not apply to the re-formed train - gating without it` };
    const tree = merged.stdout.split(/\r?\n/)[0]?.trim();
    const current = await gitExec(["rev-parse", `${trainSha}^{tree}`], { cwd: repoPath });
    if (!tree || tree === current.stdout.trim()) return { applied: false, log: `${label}: carried shepherd fix (${commits}) is already in the re-formed train` };
    const commit = await gitExec(
      ["-c", "user.name=kanban-train", "-c", "user.email=train@kanban.local", "commit-tree", tree, "-p", trainSha, "-m", `fix(train ${label}): carry shepherd fix from the inconclusive train\n\n${commits}`],
      { cwd: repoPath },
    );
    const newSha = commit.stdout.trim();
    if (!execSucceeded(commit) || !newSha) return { applied: false, log: `${label}: could not commit the carried shepherd fix (${commits}) - gating without it` };
    const moved = await gitExec(["branch", "-f", trainRef, newSha], { cwd: repoPath });
    if (!execSucceeded(moved)) return { applied: false, log: `${label}: could not advance ${trainRef} with the carried shepherd fix (${commits}) - gating without it` };
    return { applied: true, newSha, preCarrySha: trainSha, log: `${label}: carried shepherd fix commit(s) from the inconclusive train into the retry: ${commits}` };
  } catch (err) {
    return { applied: false, log: `${label}: carrying the shepherd fix (${commits}) failed (${err instanceof Error ? err.message : String(err)}) - gating without it` };
  }
}
