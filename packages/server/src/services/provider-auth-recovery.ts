/**
 * What to DO about a terminal provider auth failure (#430 steps 2 and 3).
 *
 * Step 1 landed the classification (`detectProviderAuthFailure`): a pure predicate that tells an
 * unrecoverable auth failure from a transient one. This is the half that acts on it.
 *
 * ── The measured failure ──
 *
 * A `mealplan` PM Pipeline workspace burned 10 sessions in 91 seconds, all on the SAME profile,
 * every one dying with `Failed to authenticate: OAuth session expired and could not be refreshed`.
 * Rotation never fired, because the only thing that triggered it was quota exhaustion. The
 * severity was backwards: a quota limit is self-healing and had first-class handling, while an
 * expired login — which needs a human — had none.
 *
 * ── Two responses, in order ──
 *
 * 1. **Rotate.** A dead login is exactly what the ring is for. Cooling the profile and switching to
 *    the next candidate lets the run continue on a working account instead of dying. The cooldown
 *    is long (a day, not the quota path's minutes) because nothing about an expired login changes
 *    on its own; a human re-authenticating is what ends it, and they can clear the cooldown.
 * 2. **Break the circuit.** Rotation cannot help when the ring is unconfigured, disabled, or every
 *    profile is cooled — and that is the exact state the 10-in-91-seconds loop ran in. So after
 *    `PROFILE_BREAKER_THRESHOLD` identical failures the workspace is parked `blocked` instead of
 *    returned to `idle`, which is what stops the relaunch loop: `idle` is the status every
 *    automation path treats as "start this".
 *
 * The two are deliberately independent. Rotation without the breaker still loops once the ring is
 * exhausted; the breaker without rotation stops a run that could have continued elsewhere.
 */
import type { Database } from "../db/index.js";
import type { ProviderName } from "./agent-provider.js";
import { detectProviderAuthFailure, authFailureRemedy, type ProviderAuthFailure } from "./provider-auth-failure.js";
import { isProfileBreakerOpen, readProfileFailure, PROFILE_BREAKER_THRESHOLD } from "./agent-profile-failure-record.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { rotateClaudeSubscription } from "./claude-subscription-ring.js";
import { rotateCodexLicense } from "./codex-license-ring.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * How long a profile with a dead login is cooled.
 *
 * A day, not the quota path's "until the reset time": nothing about an expired credential changes
 * on a timer. This is long enough to keep the ring off it for the rest of a run and short enough
 * that a re-authenticated profile comes back on its own if nobody clears the cooldown.
 */
export const AUTH_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface AuthRecoveryOutcome {
  /** The classified failure, or null when this was not a terminal auth problem. */
  failure: ProviderAuthFailure | null;
  rotated: boolean;
  toProfile?: string;
  /** True when this profile has now failed identically enough times to stop relaunching on it. */
  breakerOpen: boolean;
  /** Operator-facing sentence naming the remedy — empty when there is nothing to say. */
  remedy: string;
}

/** Providers that own a rotation ring. Anything else classifies and breaks, but cannot rotate. */
function rotatorFor(provider: ProviderName) {
  if (provider === "claude") return rotateClaudeSubscription;
  if (provider === "codex") return rotateCodexLicense;
  return null;
}

/**
 * Classify a launch failure, rotate away from a dead login, and report whether the profile's
 * breaker is now open.
 *
 * Never throws: this runs inside a session-exit handler, where an error would replace a reported
 * failure with an unreported one.
 */
export async function handleProviderAuthFailure(
  database: Database,
  input: {
    provider: ProviderName;
    profileName?: string | null;
    errorText: string | null | undefined;
    now?: Date;
  },
): Promise<AuthRecoveryOutcome> {
  const now = input.now ?? new Date();
  const failure = detectProviderAuthFailure(input.errorText);
  const profileName = input.profileName?.trim() || "default";
  let breakerOpen = false;
  try {
    breakerOpen = isProfileBreakerOpen(await readProfileFailure(database, input.provider, profileName));
  } catch { /* an unreadable record must not suppress the rotation below */ }

  if (!failure) return { failure: null, rotated: false, breakerOpen, remedy: "" };

  const remedy = authFailureRemedy(failure, profileName);
  const rotate = rotatorFor(input.provider);
  if (!rotate) return { failure, rotated: false, breakerOpen, remedy };

  try {
    const prefRows = await getAllPreferences(database);
    const prefMap = new Map(prefRows.map((row) => [row.key, row.value]));
    const result = await rotate(
      database,
      prefMap,
      profileName,
      new Date(now.getTime() + AUTH_FAILURE_COOLDOWN_MS).toISOString(),
      now,
    );
    return {
      failure,
      rotated: result.rotated,
      toProfile: result.toProfile,
      breakerOpen,
      remedy: result.rotated
        ? `${remedy} Rotated to "${result.toProfile}" for now.`
        : `${remedy} Could not rotate (${result.reason}).`,
    };
  } catch (err) {
    return {
      failure,
      rotated: false,
      breakerOpen,
      remedy: `${remedy} Rotation attempt failed: ${errorMessage(err)}.`,
    };
  }
}

/**
 * Apply the recovery to a workspace whose session just died on a launch failure.
 *
 * Returns TRUE when it took ownership of the workspace's resting status — i.e. parked it
 * `blocked` because the profile's breaker is open. The caller then leaves the status alone;
 * a false return means the ordinary `idle` (relaunchable) path still applies.
 *
 * Parking `blocked` is the whole mechanism: `idle` is the status every automation path reads as
 * "start this", so an auth failure that leaves the workspace idle IS the retry loop.
 */
export async function applyAuthFailureRecovery(
  database: Database,
  input: {
    provider: ProviderName;
    profileName?: string | null;
    errorText: string | null | undefined;
    workspaceId: string;
    projectId?: string;
    sessionId?: string;
    now?: string;
    setWorkspaceStatus: (status: string) => Promise<unknown>;
  },
): Promise<boolean> {
  const outcome = await handleProviderAuthFailure(database, {
    provider: input.provider,
    profileName: input.profileName,
    errorText: input.errorText,
    now: input.now ? new Date(input.now) : undefined,
  });
  if (!outcome.failure && !outcome.breakerOpen) return false;

  const profileLabel = input.profileName?.trim() || "default";
  if (outcome.failure) {
    console.warn(`[agent] terminal auth failure on session ${input.sessionId ?? "?"}: ${outcome.remedy}`);
  }
  if (outcome.breakerOpen) {
    await input.setWorkspaceStatus("blocked");
    console.warn(
      `[agent] profile "${profileLabel}" has failed identically ${PROFILE_BREAKER_THRESHOLD}+ times — `
      + `workspace ${input.workspaceId} parked blocked instead of relaunched. ${outcome.remedy}`,
    );
  }
  if (input.projectId && outcome.failure) {
    emitButlerSystemEvent({
      projectId: input.projectId,
      kind: "session_failed",
      workspaceId: input.workspaceId,
      text: `Agent auth failure (${outcome.failure.kind}) for workspace ${input.workspaceId}: ${outcome.remedy}`,
    });
  }
  return outcome.breakerOpen;
}
