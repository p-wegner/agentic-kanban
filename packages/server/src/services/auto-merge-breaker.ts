/**
 * Same-failure circuit breaker for auto-merge (#1207).
 *
 * MEASURED motivation: the fixture projects under `exp/` run in `monitor` mode with auto-merge
 * on. Every 30s window they assembled a train, and every gate failed on the SAME infrastructure
 * error - `Der Befehl "tsc" ist entweder falsch geschrieben...` (no typescript in the worktree)
 * or an install failure behind an `npm warn Unknown user config "store-dir"` banner. The members
 * went straight back to ready and the next tick repeated it: hundreds of identical
 * `[auto-merge] error ... train gate failed - nothing landed` lines in `board.log`, each costing
 * an install plus a typecheck on a 16-core box shared with real work, and none of them able to
 * succeed without a human.
 *
 * The shape follows this area's convention: the DECISIONS here are pure (`normalizeFailureSignature`,
 * `recordBreakerFailure`, `shouldClearBreaker`) and the three thin `runtime_state` accessors do
 * the I/O. Nothing here runs a gate or reads git - the orchestrator hands in the facts.
 *
 * `runtime_state`, not `preferences`: this is ephemeral per-project runtime state, exactly the
 * split #975 drew, and a breaker row must never end up in a config export.
 */
import { looksLikeMissingDepsFailure } from "./pre-merge-gate.service.js";
import { deleteRuntimeState, getRuntimeState, setRuntimeState } from "../repositories/runtime-state.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";
import { getSetupRunForGate } from "../repositories/workspace-setup-run.repository.js";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";

/** Consecutive identical failures before auto-merge is paused for the project. */
export const AUTO_MERGE_BREAKER_THRESHOLD = 3;

/** How much of a failure line is kept as the signature — enough to distinguish, short enough to compare. */
const SIGNATURE_MAX_CHARS = 120;

/**
 * The classified signature of a setup/dependency failure. Preferred over the raw first line
 * because the shell's "command not found" wording is LOCALIZED (#1092) and the exact missing
 * tool differs run to run, so two runs of the same broken install would otherwise look like two
 * different failures and the count would never reach the threshold.
 */
export const SETUP_BLOCKED_SIGNATURE = "setup-blocked:missing-deps";

export interface AutoMergeBreakerState {
  /** The normalised failure signature the consecutive count is counting. */
  signature: string;
  /** How many consecutive runs have now failed with `signature`. */
  count: number;
  /** ISO — when this signature's streak started. */
  since: string;
  /** ISO — set once the streak reached the threshold; its presence IS the pause. */
  pausedAt?: string;
  /** The base sha the failures happened on; the breaker clears when the base moves past it. */
  baseSha?: string | null;
  /** The workspace whose failure was recorded, so its setup verdict can be re-read. */
  workspaceId?: string | null;
  /** That workspace's setup-run verdict at pause time; a change clears the breaker. */
  setupVerdict?: string | null;
}

export function autoMergeBreakerKey(projectId: string): string {
  return `auto_merge_breaker_${projectId}`;
}

/**
 * One failure message → one comparable signature.
 *
 * The pre-merge gate's own setup-blocked classification wins when it matches, per the ticket:
 * matching localized shell text is exactly what made the same broken install read as a fresh
 * failure every window. Otherwise the first line that is not a warning banner — `npm warn`,
 * `[WARN]` and friends are the noise that sits IN FRONT of the real error and would otherwise
 * become the signature of every failure on the box.
 */
export function normalizeFailureSignature(message: string): string {
  if (looksLikeMissingDepsFailure(message)) return SETUP_BLOCKED_SIGNATURE;
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(npm\s+warn|npm\s+notice|warning:|\[warn\]|warn\b)/i.test(line)) continue;
    return line.slice(0, SIGNATURE_MAX_CHARS);
  }
  return message.trim().slice(0, SIGNATURE_MAX_CHARS) || "unknown failure";
}

/**
 * Fold one failure into the running state (pure).
 *
 * A DIFFERENT signature resets the count to 1 rather than incrementing — the breaker's whole
 * claim is "this is the same thing every time", and a project failing three different ways is a
 * project making progress through its problems, not one stuck in a loop.
 */
export function recordBreakerFailure(
  previous: AutoMergeBreakerState | null,
  failure: { signature: string; baseSha?: string | null; workspaceId?: string | null; setupVerdict?: string | null },
  now: string,
  threshold = AUTO_MERGE_BREAKER_THRESHOLD,
): AutoMergeBreakerState {
  const continues = previous?.signature === failure.signature;
  const count = continues ? previous.count + 1 : 1;
  const next: AutoMergeBreakerState = {
    signature: failure.signature,
    count,
    since: continues ? previous.since : now,
    baseSha: failure.baseSha ?? null,
    workspaceId: failure.workspaceId ?? null,
    setupVerdict: failure.setupVerdict ?? null,
  };
  // Latch on the run that REACHES the threshold, and keep the original `pausedAt` afterwards.
  if (count >= threshold) next.pausedAt = continues ? (previous.pausedAt ?? now) : now;
  return next;
}

/** Is auto-merge paused for this project right now? */
export function breakerIsPaused(state: AutoMergeBreakerState | null): boolean {
  return Boolean(state?.pausedAt);
}

/**
 * Should a paused breaker clear itself (pure)? Two automatic conditions, both meaning "the world
 * the failures were measured in is gone":
 *
 *  - the BASE SHA moved — whatever was broken may have been fixed by what landed since;
 *  - the failing workspace's SETUP VERDICT changed — the install that could not run has been
 *    re-run, successfully or not, so the next gate is a different experiment.
 *
 * An UNKNOWN current value never clears: a git read that failed is not evidence the base moved,
 * and clearing on it would put the project straight back into the retry loop the breaker exists
 * to stop. The operator's `POST /api/projects/:id/auto-merge/resume` is the third route and is
 * not judged here — it deletes the row outright.
 */
export function shouldClearBreaker(
  state: AutoMergeBreakerState,
  current: { baseSha?: string | null; setupVerdict?: string | null },
): string | null {
  if (state.baseSha && current.baseSha && current.baseSha !== state.baseSha) {
    return `base sha moved ${state.baseSha.slice(0, 8)} -> ${current.baseSha.slice(0, 8)}`;
  }
  if (state.workspaceId && current.setupVerdict !== undefined && current.setupVerdict !== state.setupVerdict) {
    return `setup verdict for the failing workspace changed ${state.setupVerdict ?? "none"} -> ${current.setupVerdict ?? "none"}`;
  }
  return null;
}

/** Defensive parse — the row is JSON in a writable table, and a malformed one must degrade to "no breaker". */
export function parseBreakerState(raw: string | null | undefined): AutoMergeBreakerState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.signature !== "string" || typeof parsed?.count !== "number" || typeof parsed?.since !== "string") return null;
    const state: AutoMergeBreakerState = { signature: parsed.signature, count: parsed.count, since: parsed.since };
    if (typeof parsed.pausedAt === "string") state.pausedAt = parsed.pausedAt;
    if (typeof parsed.baseSha === "string") state.baseSha = parsed.baseSha;
    if (typeof parsed.workspaceId === "string") state.workspaceId = parsed.workspaceId;
    if (typeof parsed.setupVerdict === "string") state.setupVerdict = parsed.setupVerdict;
    return state;
  } catch {
    return null;
  }
}

export async function readAutoMergeBreaker(projectId: string, database: Database): Promise<AutoMergeBreakerState | null> {
  return parseBreakerState(await getRuntimeState(autoMergeBreakerKey(projectId), database).catch(() => null));
}

export async function writeAutoMergeBreaker(projectId: string, state: AutoMergeBreakerState, database: Database): Promise<void> {
  await setRuntimeState(autoMergeBreakerKey(projectId), JSON.stringify(state), database);
}

export async function clearAutoMergeBreaker(projectId: string, database: Database): Promise<void> {
  await deleteRuntimeState(autoMergeBreakerKey(projectId), database);
}

/**
 * Is auto-merge HELD for this project right now, after re-checking the two automatic clears?
 *
 * Returns the live breaker state when the project is paused, or null (having cleared the row)
 * when the base has moved or the failing workspace's setup verdict has changed. Never throws —
 * a read failure answers "not held", because a breaker that cannot be read must not become a
 * permanent, unexplainable stop.
 */
export async function resolveAutoMergeBreakerHold(
  projectId: string,
  database: Database,
): Promise<AutoMergeBreakerState | null> {
  const state = await readAutoMergeBreaker(projectId, database);
  if (!state || !breakerIsPaused(state)) return null;
  const current = {
    baseSha: await currentBaseSha(projectId, database),
    ...(state.workspaceId ? { setupVerdict: await currentSetupVerdict(state.workspaceId, database) } : {}),
  };
  const clearReason = shouldClearBreaker(state, current);
  if (!clearReason) return state;
  await clearAutoMergeBreaker(projectId, database).catch(() => undefined);
  console.log(`[auto-merge] circuit breaker cleared for project ${projectId}: ${clearReason}`);
  return null;
}

/**
 * Fold ONE gate/train failure for a project into its breaker, persist it, and — on the run that
 * reaches the threshold — log one line and emit a board-health event.
 *
 * Called once per project per orchestrator tick, with the FIRST failure of that tick: a train's
 * members all carry the same gate failure text, so counting them individually would trip the
 * breaker inside a single window and claim three "consecutive" failures that were one.
 */
export async function recordAutoMergeGateFailure(args: {
  projectId: string;
  workspaceId: string | null;
  message: string;
  database: Database;
  broadcast?: (projectId: string) => void;
  now?: string;
}): Promise<AutoMergeBreakerState> {
  const { projectId, workspaceId, message, database } = args;
  const now = args.now ?? new Date().toISOString();
  const previous = await readAutoMergeBreaker(projectId, database);
  const next = recordBreakerFailure(previous, {
    signature: normalizeFailureSignature(message),
    baseSha: await currentBaseSha(projectId, database),
    workspaceId,
    setupVerdict: workspaceId ? await currentSetupVerdict(workspaceId, database) : null,
  }, now);
  await writeAutoMergeBreaker(projectId, next, database).catch((err) =>
    console.warn(`[auto-merge] circuit breaker persist failed for project ${projectId} (non-fatal): ${errorMessage(err)}`));

  const newlyPaused = breakerIsPaused(next) && !breakerIsPaused(previous);
  if (newlyPaused) {
    const summary = `auto-merge paused for this project: ${next.count} consecutive gate runs failed with the same signature (${next.signature})`;
    console.log(`[auto-merge] ${summary} — no further gate runs until POST /api/projects/${projectId}/auto-merge/resume, the base sha moves, or the failing workspace's setup verdict changes`);
    await logBoardHealthEvent({
      projectId,
      cycleId: `auto-merge-breaker-${now}`,
      eventType: "error",
      category: "merge",
      summary,
      details: { signature: next.signature, count: next.count, since: next.since, baseSha: next.baseSha, workspaceId: next.workspaceId },
    }, database).catch((err) => console.warn(`[auto-merge] breaker board-health event failed (non-fatal): ${errorMessage(err)}`));
    args.broadcast?.(projectId);
  }
  return next;
}

/** The project's base-branch tip right now, or null when it cannot be read (never a throw). */
async function currentBaseSha(projectId: string, database: Database): Promise<string | null> {
  const repo = await getProjectRepoFields(projectId, database).catch(() => undefined);
  if (!repo?.repoPath || !repo.defaultBranch) return null;
  return await revParse(repo.repoPath, repo.defaultBranch).catch(() => null);
}

/** The failing workspace's latest setup-run state, or null when it has none / cannot be read. */
async function currentSetupVerdict(workspaceId: string, database: Database): Promise<string | null> {
  const run = await getSetupRunForGate(workspaceId, database).catch(() => undefined);
  return run?.state ?? null;
}
