/**
 * Worker profile ATTESTATION, board side (#1027, proposal
 * `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §6 "Lokal und remote").
 *
 * ## What this narrows
 *
 * #651 refused remote dispatch for any profile-restricted project, and the reason was
 * factual rather than cautious: a worker authenticates the agent with its OWN local login
 * and the board deliberately sends no credentials (decision 012), so the board could pick
 * a permitted profile but could not make the worker honour it. "Never" was the only
 * honest answer as long as the worker said nothing about its logins.
 *
 * An attestation is the worker saying, by NAME, which accounts it can authenticate as
 * (`worker start --profiles anth,team5x`, or derived from its own profile discovery).
 * That turns the refusal into a question the board can actually ask: does this worker
 * attest a profile this project's roster permits? So "never" becomes "only to a worker
 * that attests".
 *
 * ## Why the roster machinery is REUSED rather than re-implemented
 *
 * The remote decision must be the SAME decision as the local one — `pool` ordered by
 * headroom, `reserve` only when the pool is out and reserve is allowed, `forbidden`
 * refused rather than clamped. A second selection algorithm for remote launches would be
 * the one place the two could disagree, and it would disagree exactly where it matters
 * (a client-pinned subscription). So this module only builds the INPUTS —
 * an intersected roster and a headroom map — and hands them to `resolveRosterSelection`.
 *
 * ## The trust rule
 *
 * A worker's attested `role` is combined with the project's roster by
 * {@link mostRestrictiveRole}, never replaces it: `forbidden` on EITHER side wins. A
 * worker cannot lift a restriction by declaring a friendlier role for an account, and a
 * worker attesting ONLY a forbidden profile gets nothing from that project regardless of
 * what its `--providers` say. The permissive direction is the one that is never taken on
 * a worker's word alone.
 *
 * PURE and client-safe (no node builtins): the Worker Fleet panel previews the same
 * answer the resolver will make.
 */
import type { WorkerProfileAttestation } from "@agentic-kanban/shared/lib/worker-protocol";
import type { ParsedRoster, ProfileRole, RosterEntry } from "@agentic-kanban/shared/lib/profile-roster";
import {
  DEFAULT_PROFILE_ROLE,
  isProfileRole,
  mostRestrictiveRole,
  profileRefId,
} from "@agentic-kanban/shared/lib/profile-roster";
import { narrowProvider } from "@agentic-kanban/shared/lib/provider-traits";
import type { ProfileHeadroom } from "@agentic-kanban/shared/lib/profile-roster-selection";
import { resolveRosterSelection, type RosterSelection } from "@agentic-kanban/shared/lib/profile-roster-selection";

/** The role a worker attested for one profile, narrowed to the vocabulary. */
export function attestedRole(entry: WorkerProfileAttestation): ProfileRole {
  return isProfileRole(entry.role) ? entry.role : DEFAULT_PROFILE_ROLE;
}

/** `provider:name` for an attestation, in the roster's own spelling. */
export function attestationRefId(entry: WorkerProfileAttestation): string {
  return profileRefId({ provider: narrowProvider(entry.provider), name: entry.name });
}

/**
 * Project the worker's own quota readings onto the headroom map roster selection consumes.
 *
 * Keyed both by `provider:name` and by the bare name, for the same reason
 * `headroomFromQuotaUsage` is: a roster entry is provider-qualified and a quota source
 * often is not, and a name matching only one spelling would silently read as `unknown` —
 * i.e. would disable the ordering this exists for.
 */
export function headroomFromAttestations(
  attestations: readonly WorkerProfileAttestation[] | null | undefined,
): Map<string, ProfileHeadroom> {
  const out = new Map<string, ProfileHeadroom>();
  for (const entry of attestations ?? []) {
    const quota = entry.quota;
    const stale = quota?.stale === true || quota === undefined;
    const headroom: ProfileHeadroom = {
      usedPct: stale ? null : quota?.usedPct5h ?? null,
      stale,
      // The bare key below is provider-ambiguous, so it carries the provider it is ABOUT:
      // a reading for `codex:default` must not answer for `claude:default` (see
      // `headroomRecordFor`).
      provider: narrowProvider(entry.provider),
    };
    out.set(attestationRefId(entry), headroom);
    out.set(entry.name, headroom);
  }
  return out;
}

/**
 * The roster as it applies TO ONE WORKER: the project's entries the worker attests,
 * each carrying the more restrictive of the two roles.
 *
 * An entry the worker does not attest is DROPPED, not demoted — the worker cannot log in
 * as it, so offering it would place work that then has to be rejected. An attested
 * profile the roster does not list survives only for an OPEN roster (nobody has an
 * opinion about it, so it is ordinary supply, exactly as it is locally); a CLOSED roster
 * sees only what it named.
 */
export function intersectRosterWithAttestation(
  roster: ParsedRoster,
  attestations: readonly WorkerProfileAttestation[] | null | undefined,
): ParsedRoster {
  const attested = new Map<string, WorkerProfileAttestation>();
  for (const entry of attestations ?? []) attested.set(attestationRefId(entry), entry);

  const entries: RosterEntry[] = [];
  for (const entry of roster.entries) {
    const match = attested.get(profileRefId(entry));
    if (!match) continue;
    entries.push({ ...entry, role: mostRestrictiveRole(entry.role, attestedRole(match)) });
  }
  if (!roster.closed) {
    // An OPEN roster names only the profiles somebody has an opinion about, so an attested
    // profile it never mentions is ordinary supply. Adding it here (rather than leaving the
    // selection to fall through on an empty list) is what keeps an unrestricted-by-name
    // worker usable while a `forbidden` read still bites.
    for (const [id, entry] of attested) {
      if (roster.entries.some((e) => profileRefId(e) === id)) continue;
      entries.push({
        provider: narrowProvider(entry.provider),
        name: entry.name,
        role: attestedRole(entry),
        ...(entry.dedicatedProject ? { dedicatedProject: entry.dedicatedProject } : {}),
      });
    }
  }
  return { ...roster, entries };
}

export interface AttestedProfileSelectionInput {
  /** The project's resolved roster (`resolveProjectRoster`). */
  roster: ParsedRoster;
  /** What this worker declared on `hello`/heartbeat. Absent/empty = attests nothing. */
  attestations: readonly WorkerProfileAttestation[] | null | undefined;
  /** Cooldown stamps (`<provider>_cooldown_<profile>`), read straight off the pref map. */
  prefMap: Map<string, string>;
  nowMs: number;
  /** The 5-hour-window percentage at or above which a pool profile is exhausted. */
  exhaustedPct?: number;
  /** May this launch reach for a `reserve` profile? See `resolveReserveAllowance`. */
  reserveAllowed?: boolean;
}

/**
 * Which profile would this worker run this project's work under — or why it cannot.
 *
 * `selection: null` is never "no opinion" here: a restricted project that gets no
 * selection must NOT be dispatched to this worker. `holdReason` says why, in the words a
 * placement refusal (or the Monitor's skip) prints.
 */
export function selectAttestedProfile(input: AttestedProfileSelectionInput): RosterSelection {
  const intersected = intersectRosterWithAttestation(input.roster, input.attestations);
  return resolveRosterSelection({
    roster: intersected,
    // No requested profile: the board is asking "what would this worker run it as", and a
    // board-side preference must not smuggle an unattested name past the intersection.
    provider: null,
    profileName: null,
    prefMap: input.prefMap,
    nowMs: input.nowMs,
    headroom: headroomFromAttestations(input.attestations),
    ...(input.exhaustedPct !== undefined ? { exhaustedPct: input.exhaustedPct } : {}),
    ...(input.reserveAllowed !== undefined ? { reserveAllowed: input.reserveAllowed } : {}),
  });
}

/** One worker's answer, with the worker it belongs to. */
export interface AttestedWorkerCandidate {
  workerId: string;
  /** The profile this worker would run under, or null when it may not take the work. */
  profile: { provider: string; name: string; role: ProfileRole } | null;
  /** Why not, when `profile` is null. */
  holdReason: string | null;
  /** True when the chosen profile is a `reserve` — the caller LOGS this. */
  usedReserve: boolean;
}

/**
 * Ask {@link selectAttestedProfile} of every candidate worker, keeping the order the
 * caller gave (which is already the #910 headroom ranking of the MACHINES). Profile
 * headroom orders within a worker; machine headroom orders between them — deliberately
 * not merged into one score, because they measure different scarce things.
 */
export function selectAttestedWorkers(
  workers: ReadonlyArray<{ workerId: string; attestations?: readonly WorkerProfileAttestation[] | null }>,
  input: Omit<AttestedProfileSelectionInput, "attestations">,
): AttestedWorkerCandidate[] {
  return workers.map((worker) => {
    const result = selectAttestedProfile({ ...input, attestations: worker.attestations });
    return {
      workerId: worker.workerId,
      profile: result.selection
        ? { provider: result.selection.provider, name: result.selection.name, role: result.selection.role }
        : null,
      holdReason: result.holdReason,
      usedReserve: result.usedReserve,
    };
  });
}
