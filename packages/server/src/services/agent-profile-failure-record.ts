/**
 * The per-profile launch-failure record, and the circuit breaker built on it (#430 step 3).
 *
 * The record itself is old: every launch failure already wrote the latest one here. NOTHING
 * consulted it, which is how an EXPIRED OAuth login came to be retried ~10 times in 90 seconds —
 * each attempt a fresh launch, each failing identically, none of them able to succeed, and the
 * only signal that would have said so sitting unread in this key.
 *
 * Counting is what turns "it failed" into "it will keep failing", which is the only basis on which
 * relaunching can be refused. Split out of `agent-profile-health.service.ts` so the counter, the
 * threshold and the readers live together rather than beside the preflight/version machinery.
 */
import type { ProviderName } from "./agent-provider.js";
import type { Database } from "../db/index.js";
import { deleteRuntimeState, getRuntimeState, setRuntimeState } from "../repositories/runtime-state.repository.js";

export const FAILURE_PREFIX = "agent_profile_launch_failure.";
const DEFAULT_PROFILE = "default";

export interface AgentProfileFailureSummary {
  at: string;
  provider: ProviderName;
  profileName: string;
  summary: string;
  exitCode?: number | null;
  sessionId?: string;
  workspaceId?: string;
  /**
   * How many times IN A ROW this profile has failed with the same failure class.
   * Reset by `recordAgentProfileLaunchSuccess`, so an intermittent failure never accumulates.
   */
  consecutive?: number;
  /** When the current streak started — the count alone does not say over what period. */
  firstAt?: string;
}

/**
 * Consecutive identical failures before a profile is treated as unusable.
 *
 * Three, not one: a single launch failure can be transient (a killed process, a sleeping machine,
 * a provider blip), and declaring a working profile dead is worse than one wasted retry. Three
 * identical failures in a row against the same profile is not a blip.
 */
export const PROFILE_BREAKER_THRESHOLD = 3;

/**
 * The failure "class" two failures must share to count as one streak.
 *
 * The raw summary carries a duration and often a session id, so comparing it verbatim would reset
 * the streak on every attempt and the counter would never reach the threshold. Digits are
 * normalised away and the leading sentence is what remains.
 */
export function failureClassOf(summary: string): string {
  return summary.replace(/\d+/g, "#").slice(0, 120);
}

/** True when this profile has failed identically often enough to stop relaunching on it. */
export function isProfileBreakerOpen(
  failure: AgentProfileFailureSummary | null | undefined,
  threshold = PROFILE_BREAKER_THRESHOLD,
): boolean {
  return (failure?.consecutive ?? 0) >= threshold;
}

export function profileFailureKey(provider: ProviderName, profileName?: string | null): string {
  return `${FAILURE_PREFIX}${provider}:${profileName?.trim() || DEFAULT_PROFILE}`;
}

function sanitize(message: string): string {
  return message
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]")
    .replace(/([A-Za-z0-9_]*token[A-Za-z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .replace(/([A-Za-z0-9_]*key[A-Za-z0-9_]*=)[^\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

/** Merge one failure into the profile's record, continuing or restarting the streak. */
export function nextFailureRecord(
  previous: AgentProfileFailureSummary | null,
  input: {
    provider: ProviderName;
    profileName: string;
    summary: string;
    exitCode?: number | null;
    sessionId?: string;
    workspaceId?: string;
    at: string;
  },
): AgentProfileFailureSummary {
  const summary = sanitize(input.summary);
  // Same class => the streak continues; anything else starts a new one. Without this the count
  // would be "how many times has this profile ever failed", which is no basis for refusing a launch.
  const sameClass = previous ? failureClassOf(previous.summary) === failureClassOf(summary) : false;
  return {
    at: input.at,
    provider: input.provider,
    profileName: input.profileName,
    summary,
    exitCode: input.exitCode,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    consecutive: sameClass ? (previous?.consecutive ?? 1) + 1 : 1,
    firstAt: sameClass ? (previous?.firstAt ?? previous?.at ?? input.at) : input.at,
  };
}

export async function readProfileFailure(
  database: Database,
  provider: ProviderName,
  profileName?: string | null,
): Promise<AgentProfileFailureSummary | null> {
  const value = await getRuntimeState(profileFailureKey(provider, profileName), database).catch(() => null);
  if (!value) return null;
  try {
    return JSON.parse(value) as AgentProfileFailureSummary;
  } catch {
    return null;
  }
}

export async function writeProfileFailure(
  database: Database,
  record: AgentProfileFailureSummary,
): Promise<void> {
  await setRuntimeState(profileFailureKey(record.provider, record.profileName), JSON.stringify(record), database);
}

/**
 * Clear a profile's failure record after a session that actually ran.
 *
 * Without this the streak is permanent: a profile that failed three times in a row last week, was
 * fixed, and has worked since would still read as unusable.
 */
export async function recordAgentProfileLaunchSuccess(
  database: Database,
  input: { provider: ProviderName; profileName?: string | null },
): Promise<void> {
  await deleteRuntimeState(profileFailureKey(input.provider, input.profileName), database).catch(() => {});
}
