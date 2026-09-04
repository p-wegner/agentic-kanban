/**
 * "May this restricted project run on a fleet worker, and as WHICH profile?" (#1027)
 *
 * #651's answer was "never", and it was the honest one: the board sends no credentials
 * (decision 012), so it could pick a permitted profile but could not make a worker honour
 * it. Worker ATTESTATION — a worker declaring the profile NAMES it can authenticate as,
 * the way it already declares `--providers` and `--labels` — is what turns that into
 * "only to a worker that attests".
 *
 * This module is the board-side half of that question, kept OUT of
 * `worker-fleet.service.ts` for the same reason `placement-evaluators.ts` is kept out of
 * `placement-explain.service.ts`: both files sit at the god-module ceiling (#889), and
 * this is a self-contained decision with its own vocabulary.
 *
 * Everything about WHICH profile is delegated to the shared, pure
 * `worker-profile-attestation.ts`, which in turn delegates to the roster selection every
 * LOCAL launch uses. A remote launch must not get a second selection algorithm: the whole
 * point of a roster is that one rule decides, and the place it would matter that two
 * disagreed is a subscription pinned to one client.
 */
import {
  PREF_CLAUDE_SUBSCRIPTION_RING,
  PREF_CODEX_LICENSE_RING,
} from "../constants/preference-keys.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import {
  allowedProfilesPrefKey,
  remoteDispatchBlockedByAllowlist,
  resolvePoolExhaustedPct,
  resolveProjectRoster,
  resolveReserveAllowance,
  rosterPrefKey,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import { selectAttestedWorkers } from "../lib/worker-profile-attestation.js";
import type { AttestedWorkerCandidate } from "../lib/worker-profile-attestation.js";
import type { WorkerProfileAttestation } from "@agentic-kanban/shared/lib/worker-protocol";
import type { RosterEntry } from "@agentic-kanban/shared/lib/profile-roster";
import type { Database } from "../db/index.js";
import { loadObservedGlobalRoster } from "./profile-roster.service.js";

/** One worker as this decision sees it: an id plus what it attested. */
export interface AttestingWorker {
  workerId: string;
  profiles?: WorkerProfileAttestation[] | undefined;
}

export interface RemoteProfileAttestationInput {
  database: Database;
  projectId: string;
  /** Eligible workers, in the order placement would consider them. */
  workers: readonly AttestingWorker[];
  /** Injected clock (`nowMs` spelling, #614). */
  nowMs?: number;
  /**
   * The observed global roster, when the caller already has one (or a test wants a
   * deterministic one instead of whatever logins this machine happens to hold).
   */
  globalRoster?: RosterEntry[];
}

export interface RemoteProfileAttestation {
  /** Does this project restrict profiles at all? False = nothing here applies. */
  restricted: boolean;
  /** Workers that attest a profile this project permits, with the profile each would use. */
  permitted: Array<{ workerId: string; profile: { provider: string; name: string }; usedReserve: boolean }>;
  /** Every candidate's verdict, for the explanation and the log. */
  candidates: AttestedWorkerCandidate[];
  /** One line naming what was found — appended to a refusal so it says WHY, not just that. */
  detail: string;
}

/**
 * Which of these workers may take this project's work, and as what.
 *
 * Fails CLOSED in the way that matters: a project whose roster is present but unreadable
 * is `restricted` with nothing permitted, because `resolveProjectRoster` reports a
 * malformed value as restricted — a kill-switch that fails open is not a kill-switch.
 */
export async function resolveRemoteProfileAttestation(
  input: RemoteProfileAttestationInput,
): Promise<RemoteProfileAttestation> {
  const { database, projectId, workers } = input;
  const nowMs = input.nowMs ?? Date.now();
  const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
  const project = await getProjectById(projectId, database).catch(() => null);
  const roster = resolveProjectRoster({
    globalRoster: input.globalRoster ?? loadObservedGlobalRoster({
      claudeRingRaw: prefMap.get(PREF_CLAUDE_SUBSCRIPTION_RING),
      codexRingRaw: prefMap.get(PREF_CODEX_LICENSE_RING),
    }),
    rosterRaw: prefMap.get(rosterPrefKey(projectId)),
    allowlistRaw: prefMap.get(allowedProfilesPrefKey(projectId)),
    projectSlug: project?.name ?? null,
  });
  if (!roster.restricted) {
    return { restricted: false, permitted: [], candidates: [], detail: "project restricts no profile" };
  }
  // A remote placement is not an operator pressing start on one ticket, so the two
  // per-ticket grants (`reserve:ok`, an explicit start) are deliberately not consulted
  // here — only the project-level flag. Reaching for an emergency account is a decision
  // someone has to have made, and "the scheduler placed it remotely" is not one.
  const reserve = resolveReserveAllowance({ prefMap, projectId });
  const candidates = selectAttestedWorkers(
    workers.map((w) => ({ workerId: w.workerId, attestations: w.profiles ?? null })),
    {
      roster,
      prefMap,
      nowMs,
      exhaustedPct: resolvePoolExhaustedPct(prefMap, projectId),
      reserveAllowed: reserve.allowed,
    },
  );
  const permitted = candidates
    .filter((c): c is AttestedWorkerCandidate & { profile: NonNullable<AttestedWorkerCandidate["profile"]> } =>
      c.profile !== null,
    )
    .map((c) => ({
      workerId: c.workerId,
      profile: { provider: c.profile.provider, name: c.profile.name },
      usedReserve: c.usedReserve,
    }));
  return { restricted: true, permitted, candidates, detail: describeAttestation(workers.length, candidates) };
}

/**
 * The sentence a refusal or an explanation appends.
 *
 * Deliberately names the failing SHAPE rather than just a count: "no worker is connected"
 * and "three workers are connected and none attests a permitted profile" send an operator
 * to entirely different fixes, and the second is the one worker attestation newly makes
 * possible to be wrong about.
 */
export function describeAttestation(
  workerCount: number,
  candidates: readonly AttestedWorkerCandidate[],
): string {
  if (workerCount === 0) return "no eligible worker is connected to attest anything";
  const permitted = candidates.filter((c) => c.profile !== null);
  if (permitted.length > 0) {
    return `${permitted.length} of ${workerCount} eligible worker(s) attest a permitted profile (` +
      permitted.map((c) => `${c.workerId}: ${c.profile!.provider}:${c.profile!.name}`).join(", ") +
      ")";
  }
  const reasons = candidates
    .map((c) => `${c.workerId}: ${c.holdReason ?? "attests no profile this project permits"}`)
    .join("; ");
  return `no eligible worker attests a permitted profile (${reasons || "none attested anything"})`;
}

/** The profile one worker would run this project's work under, once it has been chosen. */
export interface ChosenAttestedProfile {
  profile: { provider: string; name: string };
  usedReserve: boolean;
}

/**
 * The #651 question, answered with #1027's narrowing: may this project dispatch remotely,
 * and if so, to which workers and as what?
 *
 * One function rather than five statements in `resolvePlacementWithReservation` because
 * that resolver is at the per-function branch ceiling (#726) — and because this is one
 * decision with one answer, not five steps the resolver has to sequence correctly.
 *
 * `listEligibleWorkers` is a callback so the attestation pass costs NOTHING for an
 * unrestricted project: the eligible set is only enumerated once we know a restriction is
 * in force, which for almost every project is never.
 */
export async function resolveAttestationGate(params: {
  database: Database;
  projectId: string;
  allowlistRaw: string | null | undefined;
  rosterRaw: string | null | undefined;
  listEligibleWorkers: () => Promise<AttestingWorker[]>;
  /** Explicit `undefined` is accepted so a caller can forward its own optional clock in one field. */
  nowMs?: number | undefined;
}): Promise<{
  block: { blocked: false } | { blocked: true; reason: string };
  /** Workers permitted to take this work, and the profile each would use. Null = no restriction. */
  profileByWorker: Map<string, ChosenAttestedProfile> | null;
}> {
  const { allowlistRaw, rosterRaw } = params;
  if (!remoteDispatchBlockedByAllowlist(allowlistRaw, rosterRaw).blocked) {
    return { block: { blocked: false }, profileByWorker: null };
  }
  const attestation = await resolveRemoteProfileAttestation({
    database: params.database,
    projectId: params.projectId,
    workers: await params.listEligibleWorkers(),
    ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
  });
  const block = remoteDispatchBlockedByAllowlist(allowlistRaw, rosterRaw, {
    permittedWorkers: attestation.permitted.length,
    detail: attestation.detail,
  });
  return {
    block,
    profileByWorker: new Map(
      attestation.permitted.map((p) => [p.workerId, { profile: p.profile, usedReserve: p.usedReserve }]),
    ),
  };
}

/**
 * Stamp the chosen profile onto a remote placement, saying so when it is the RESERVE.
 *
 * A reserve start is never silent, remote or local: it is the emergency account being
 * spent, and an operator has to be able to see that it happened and why.
 */
export function attestedProfilePlacementFields(
  chosen: ChosenAttestedProfile | undefined,
  context: { projectId: string; workerId: string; log?: (line: string) => void },
): { profile?: { provider: string; name: string } } {
  if (!chosen) return {};
  if (chosen.usedReserve) {
    const log = context.log ?? ((line: string) => console.warn(line));
    log(
      `[worker-fleet] RESERVE profile ${chosen.profile.provider}:${chosen.profile.name} selected for project ` +
        `${context.projectId} on worker ${context.workerId} — every pool profile it attests is exhausted or cooling`,
    );
  }
  return { profile: chosen.profile };
}
