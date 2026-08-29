/**
 * The missing-transcript resume policy (#26, widened by #934) — one module, because the
 * rule was spread across four sites in `session-lifecycle.ts` and one of them was wrong.
 *
 * A resumed launch can die because the PROVIDER no longer has the conversation it was told
 * to `--resume`: the state volume was deleted, `~/.claude` was pruned, an image was rebuilt
 * without persisted state, or — the #934 case — the transcript simply aged out between the
 * original run and a follow-up turn hours later. The right response is not to report a
 * launch failure but to clear the dead resume id and relaunch FRESH, carrying the prompt.
 *
 * The retry has to be bounded or an unrelated launch failure that happens to match the
 * error signature would loop. The bound is per WORKSPACE, and it is spent per stale-resume
 * EPISODE: any completed session clears it (`clearStaleResumeRecoveries`), because a run
 * that actually completed proves the workspace can launch. Before #934 nothing cleared it,
 * so one recovery permanently disarmed the fallback for that workspace and the next stale
 * `--resume` — a follow-up turn days later — silently dropped its content again.
 */
import { getProviderExitBehavior } from "../agent-provider/provider-exit-behavior.js";
import type { ProviderName } from "../agent-provider.js";

/** Automatic fresh-launch retries allowed per workspace per stale-resume episode. */
export const MAX_STALE_RESUME_RECOVERIES = 1;

/** The counter map this policy owns, named as a port so the state shape stays injectable. */
export type StaleResumeCounters = Map<string, number>;

/**
 * Decide whether this launch failure is a recoverable missing-transcript resume.
 *
 * Pure (a decision function per the server package's own convention): no DB, no I/O — the
 * caller supplies the error text it already extracted and the counter it already holds.
 */
export function isRecoverableStaleResume(input: {
  /** The provider session id actually forwarded as `--resume`, if any. */
  usedProviderSessionId: string | undefined;
  /** How many automatic recoveries this workspace has already spent this episode. */
  recoveryCount: number;
  /** The launched provider, whose exit behavior owns the error signature. */
  provider: ProviderName;
  /** The error text the exit produced (result event, plan text, or stderr). */
  errorText: string;
}): boolean {
  return (
    Boolean(input.usedProviderSessionId) &&
    input.recoveryCount < MAX_STALE_RESUME_RECOVERIES &&
    getProviderExitBehavior(input.provider).isStaleResumeError(input.errorText)
  );
}

export function staleResumeRecoveryCount(counters: StaleResumeCounters, workspaceId: string): number {
  return counters.get(workspaceId) ?? 0;
}

export function recordStaleResumeRecovery(counters: StaleResumeCounters, workspaceId: string): void {
  counters.set(workspaceId, staleResumeRecoveryCount(counters, workspaceId) + 1);
}

/**
 * A session COMPLETED, so the workspace can plainly launch — release the bound. Same
 * reasoning as the #430 failure-streak clear: evidence of a working launch retires the
 * circuit breaker rather than letting it outlive the problem.
 */
export function clearStaleResumeRecoveries(counters: StaleResumeCounters, workspaceId: string): void {
  counters.delete(workspaceId);
}

/**
 * True when this workspace has spent its budget with no session completing since — i.e. a
 * further resume would fail the same way and the fallback is no longer allowed to rescue it.
 *
 * `POST /api/workspaces/:id/turn` consults this BEFORE requesting a resume, so it can refuse
 * with `TRANSCRIPT_GONE` instead of answering 201 for content that is about to be dropped —
 * which is the failure #934 was filed on.
 */
export function isStaleResumeRecoveryExhausted(counters: StaleResumeCounters, workspaceId: string): boolean {
  return staleResumeRecoveryCount(counters, workspaceId) >= MAX_STALE_RESUME_RECOVERIES;
}
