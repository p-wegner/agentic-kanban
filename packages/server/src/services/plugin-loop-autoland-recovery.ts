/**
 * Monitor-side recovery for an `autoLand` loop unit whose exit hook never ran (#444).
 *
 * ── The measured stall ──
 *
 * mealplan step 7, 2026-08-12. The builder was reattached across three server restarts (tsx watch,
 * triggered by unrelated edits). On the last one the process exited without an observable code:
 *
 *     [agent] reattached process exited: sessionId=6491d655… pid=30912
 *     [agent] external exit indeterminate (exit code unobserved): workspace=6556d60b…
 *
 * The exit workflow never ran, so the `autoLand` path in `exit-workflow.ts` never fired. The agent
 * had already self-marked its ticket Done via MCP ~3s earlier, so the end state was: **issue Done,
 * branch holding 2947 insertions of real work, workspace idle, master untouched.** The loop cannot
 * advance from there — the planner reads the MAIN checkout, and the external-key dedupe makes every
 * re-advance a no-op.
 *
 * ── What already worked, and is NOT re-done here ──
 *
 * The stall IS detected and IS visible: `classifyLoopStall` returned `builder-finished-unmerged`
 * with `mergeSafe: true`, and since #440 that reaches `GET /api/inbox`, the butler and the bell.
 * One `POST /workspaces/:id/merge` unwedged it. The gap was that recovery stayed MANUAL for a state
 * the board itself had already classified as safe to land — on an `autoLand` loop, which exists
 * precisely so nobody has to click.
 *
 * ── Why this is deliberately narrow ──
 *
 * Auto-merging is the most destructive thing this pass could get wrong, so every condition below is
 * a veto and the default answer is "leave it alone":
 *
 * - **`autoLand` only.** A loop that never opted into landing its own units does not acquire the
 *   behaviour by stalling.
 * - **`mergeSafe: true` only.** #363's zero-commit parked workspace must stay untouched: landing one
 *   closes the unit without its artifacts and deadlocks the loop — the failure `exit-workflow.ts`
 *   already refuses by name. `workspace-closed-unmerged` (#445) is excluded for the same reason.
 * - **Commits ahead > 0, verified by git**, not inferred from status. An UNKNOWN count (git could
 *   not answer) blocks the landing; that polarity is the opposite of `hasCommitsAhead`, which
 *   assumes work exists so it never discards any. Here the risk runs the other way.
 * - **A minimum age.** A workspace one second into its own exit sequence must never be raced; the
 *   normal path is always given the chance to land it first.
 * - **The same gate.** Landing goes through the ordinary merge action with `RUN_GATE`, so the
 *   recovery path is never weaker than the path it stands in for.
 *
 * Worth noting for whoever picks up the upstream half: why the exit code was unobservable at all is
 * a separate question (#909's drain fix covers exit-before-output-drain, not a reattached PID poll
 * that finds the process gone without a code). If reattach classification can be made determinate,
 * this pass goes back to being a backstop rather than a routine.
 */
import { commitsAhead } from "../startup/branch-commits.js";
import type { LoopStall } from "./plugin-loop-stall.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * How long a stall must have been held before this pass will land it.
 *
 * Long enough that the ordinary exit workflow — including a review session and its own merge — has
 * had every chance to run. The stalls this exists for are measured in hours; nothing is lost by
 * waiting, and racing a workspace mid-exit is the one way this pass could cause the damage it is
 * meant to repair.
 */
export const DEFAULT_AUTOLAND_RECOVERY_MIN_AGE_MS = 15 * 60 * 1000;

export interface AutoLandRecoveryDecision {
  land: boolean;
  /** Why not, when `land` is false — logged, so a skipped recovery is never silent. */
  reason: string;
}

/**
 * Pure predicate over the already-computed stall. Split out from the git/DB work so the whole
 * veto table above is testable without a repo.
 */
export function shouldRecoverAutoLand(
  stall: LoopStall | null | undefined,
  opts: { autoLand: boolean; nowMs: number; minAgeMs?: number },
): AutoLandRecoveryDecision {
  if (!stall) return { land: false, reason: "no stall" };
  if (!opts.autoLand) return { land: false, reason: "loop did not opt into autoLand" };
  if (stall.reason !== "builder-finished-unmerged") {
    return { land: false, reason: `stall is "${stall.reason}", not a finished-but-unlanded builder` };
  }
  if (!stall.mergeSafe) return { land: false, reason: "stall is not mergeSafe" };
  const heldMs = opts.nowMs - new Date(stall.since).getTime();
  const minAgeMs = opts.minAgeMs ?? DEFAULT_AUTOLAND_RECOVERY_MIN_AGE_MS;
  // An unparseable/absent timestamp reads as "too new": we cannot show the exit path has finished,
  // and this pass never lands on an assumption.
  if (!Number.isFinite(heldMs)) return { land: false, reason: "workspace has no readable updatedAt" };
  if (heldMs < minAgeMs) {
    return { land: false, reason: `held only ${Math.round(heldMs / 1000)}s — below the ${Math.round(minAgeMs / 1000)}s floor` };
  }
  return { land: true, reason: "finished, mergeSafe, aged past the floor" };
}

export interface AutoLandRecoveryContext {
  /** The stalled workspace's worktree + base, for the commits-ahead re-check. */
  workspace: { id: string; workingDir: string | null; baseBranch: string | null } | null;
  /** The board's ordinary merge action. Must run the full pre-merge gate. */
  land: (workspaceId: string) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Land a stalled `autoLand` unit, or explain why not. Returns true only when the merge was started.
 *
 * Errors from the merge itself are caught and logged: a failing gate is a legitimate outcome here
 * (the branch is then left exactly as it was, still visible as a stall), and one loop's failed
 * recovery must never take the monitor cycle down.
 */
export async function recoverStrandedAutoLand(
  stall: LoopStall | null | undefined,
  opts: { autoLand: boolean; nowMs: number; minAgeMs?: number },
  ctx: AutoLandRecoveryContext,
): Promise<boolean> {
  const decision = shouldRecoverAutoLand(stall, opts);
  if (!decision.land || !stall) return false;
  const ws = ctx.workspace;
  if (!ws || !ws.workingDir || !ws.baseBranch) {
    ctx.log(`autoLand recovery skipped for workspace ${stall.workspaceId} — no worktree/base to verify commits against`);
    return false;
  }
  const ahead = await commitsAhead(ws.workingDir, ws.baseBranch);
  if (ahead === null) {
    ctx.log(`autoLand recovery skipped for workspace ${ws.id} — git could not count commits ahead of ${ws.baseBranch}`);
    return false;
  }
  if (ahead === 0) {
    // #363's shape reached through a different door. Landing it would close the unit without its
    // artifacts and deadlock the loop.
    ctx.log(`autoLand recovery REFUSED for workspace ${ws.id} — branch has no unique commits; the unit needs a relaunch, not a merge`);
    return false;
  }
  ctx.log(`autoLand recovery: landing stranded loop workspace ${ws.id} (${ahead} commit(s) ahead of ${ws.baseBranch}, ${decision.reason})`);
  try {
    await ctx.land(ws.id);
    return true;
  } catch (err) {
    ctx.log(`autoLand recovery merge failed for workspace ${ws.id}: ${errorMessage(err)}`);
    return false;
  }
}
