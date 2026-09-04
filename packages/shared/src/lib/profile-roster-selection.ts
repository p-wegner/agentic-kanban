/**
 * Roster SELECTION (#1025): given a project's resolved roster, which profile does this
 * launch actually run on — and when must it not run at all?
 *
 * The parsing/narrowing half is `profile-roster.ts`; this is the decision. It is the ONE
 * place the three roles turn into an answer, and it is deliberately pure: the enforcement
 * seam (`resolveProjectRuntimeConfig` → `resolveProviderConfig`) passes in the prefs, the
 * clock and the quota headroom, and gets back a selection plus everything a caller needs
 * to LOG and to SHOW (a reserve start is a warning in the Monitor view, not a silent
 * substitution).
 *
 * Three outcomes, and they are not interchangeable:
 *  - **selection** — launch on this. `clamped` says whether it differs from what was asked.
 *  - **hold** (`holdReason`) — the roster permits nothing right now. The caller MUST NOT
 *    launch: falling back to an unrostered profile breaks the restriction at exactly the
 *    moment it matters.
 *  - **refusal** (`refused`) — a `forbidden` profile was requested. This is NOT clamped to
 *    something else, because "we ignored your explicit choice and used another account"
 *    is precisely as wrong as honouring it when the account is one that must never see
 *    this work. It is reported and the launch stops.
 *
 * Ordering inside `pool` is by REMAINING 5-hour headroom, not list order. An `unknown`
 * measurement (never taken, or older than one reset window — see
 * `oauth-quota-provider.ts`) sorts AFTER every fresh measurement and is never treated as
 * exhausted: old beats wrong, and dropping a profile whose number we simply do not have
 * would take a perfectly usable account out of rotation.
 */
import { narrowProvider, profileOptionLabel } from "./provider-traits.js";
import type { ParsedRoster, ProfileRef, RosterEntry } from "./profile-roster.js";
import {
  DEFAULT_POOL_EXHAUSTED_PCT,
  DEFAULT_PROFILE_ROLE,
  isProfileCooling,
  profileCooldownKey,
  profileRefId,
} from "./profile-roster.js";

/** One profile's 5-hour-window reading. */
export interface ProfileHeadroom {
  /** Percent of the window USED (0–100), or null when nothing has been measured. */
  usedPct: number | null;
  /** The measurement is older than one reset window — treat as unknown, not as exhausted. */
  stale?: boolean;
}

/** The minimal shape of a `QuotaUsageResult` this module needs. */
export interface QuotaUsageLike {
  providers: Array<{
    id: string;
    status?: string;
    stale?: boolean | null;
    metrics?: Array<{ label: string; percent: number | null; periodMs?: number | null }>;
  }>;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * Project a quota snapshot onto the headroom map this module consumes.
 *
 * Keyed BOTH by `provider:name` and by the bare profile name, because the quota source
 * identifies a Claude profile by its name alone while a roster entry is always
 * provider-qualified — and a name that only matched one of the two spellings would read
 * as `unknown`, i.e. would silently disable the ordering this exists for.
 */
export function headroomFromQuotaUsage(result: QuotaUsageLike | null | undefined): Map<string, ProfileHeadroom> {
  const out = new Map<string, ProfileHeadroom>();
  for (const entry of result?.providers ?? []) {
    const metric = (entry.metrics ?? []).find(
      (m) => m.periodMs === FIVE_HOURS_MS || /5[\s-]?h/i.test(m.label ?? ""),
    );
    const stale = entry.stale === true || entry.status === "unknown";
    const headroom: ProfileHeadroom = { usedPct: stale ? null : metric?.percent ?? null, stale };
    out.set(entry.id, headroom);
    out.set(`claude:${entry.id}`, headroom);
  }
  return out;
}

/** The reading for one ref: absent, stale and never-measured all mean `unknown`. */
function headroomOf(entry: ProfileRef, headroom: Map<string, ProfileHeadroom> | null | undefined): number | null {
  const rec = headroom?.get(profileRefId(entry)) ?? headroom?.get(entry.name);
  if (!rec || rec.stale) return null;
  return typeof rec.usedPct === "number" && Number.isFinite(rec.usedPct) ? rec.usedPct : null;
}

/**
 * Rank candidates by remaining headroom, descending. Unknown measurements keep their
 * declared order and come last — which is also why a board with NO quota source at all
 * gets exactly the historic list-order behaviour out of this function.
 */
export function rankRosterEntries(
  entries: readonly RosterEntry[],
  headroom?: Map<string, ProfileHeadroom> | null,
): RosterEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, used: headroomOf(entry, headroom) }))
    .sort((a, b) => {
      if (a.used === null && b.used === null) return a.index - b.index;
      if (a.used === null) return 1;
      if (b.used === null) return -1;
      return a.used === b.used ? a.index - b.index : a.used - b.used;
    })
    .map((r) => r.entry);
}

export interface RosterSelectionInput {
  roster: ParsedRoster;
  /** What the precedence chain resolved (an untrusted provider string is fine). */
  provider: string | null | undefined;
  profileName: string | null | undefined;
  /** Cooldown stamps live here (`<provider>_cooldown_<profile>`). */
  prefMap: Map<string, string>;
  nowMs: number;
  headroom?: Map<string, ProfileHeadroom> | null;
  /** Percent of the 5-hour window at or above which a pool profile is exhausted. */
  exhaustedPct?: number;
  /** May this launch reach for a `reserve` profile? See `resolveReserveAllowance`. */
  reserveAllowed?: boolean;
}

export interface RosterSelection {
  /** The profile to launch under, or null when the caller must NOT launch. */
  selection: RosterEntry | null;
  /** True when `selection` differs from what was asked for. */
  clamped: boolean;
  /** True when a `forbidden` profile was requested — a refusal, not a substitution. */
  refused: boolean;
  /** Why the caller must not launch. Null whenever `selection` is non-null. */
  holdReason: string | null;
  /** Human-readable diagnostics for the caller to log. */
  note: string | null;
  /** True when the selection is a `reserve` profile — LOG this and show it. */
  usedReserve: boolean;
  /** The reserve start, spelled out for the log and the Monitor view. */
  reserveNote: string | null;
  /** The pool in the order it was considered — the Monitor view's "why this one". */
  poolOrder: string[];
}

const PASS_THROUGH: RosterSelection = {
  selection: null,
  clamped: false,
  refused: false,
  holdReason: null,
  note: null,
  usedReserve: false,
  reserveNote: null,
  poolOrder: [],
};

function describeEntry(
  entry: RosterEntry,
  input: RosterSelectionInput,
  exhaustedPct: number,
): string {
  const id = profileRefId(entry);
  const until = input.prefMap.get(profileCooldownKey(entry.provider, entry.name));
  if (until && isProfileCooling(entry, input.prefMap, input.nowMs)) return `${id} until ${until}`;
  const used = headroomOf(entry, input.headroom);
  if (used !== null && used >= exhaustedPct) return `${id} at ${used}% of the 5-hour window`;
  return id;
}

/** The role this roster assigns a ref: an OPEN roster treats an unlisted profile as pool. */
function roleOf(roster: ParsedRoster, ref: ProfileRef | null): "pool" | "reserve" | "forbidden" | "excluded" {
  if (!ref) return "excluded";
  const listed = roster.entries.find((e) => profileRefId(e) === profileRefId(ref));
  if (listed) return listed.role;
  return roster.closed ? "excluded" : DEFAULT_PROFILE_ROLE;
}

/**
 * Decide what this launch runs on.
 *
 * Callers MUST check `holdReason`/`refused` before launching — an unchecked null
 * `selection` would otherwise read as "no opinion" and let the caller proceed on the
 * unrestricted choice, which is the failure this whole module exists to prevent.
 */
export function resolveRosterSelection(input: RosterSelectionInput): RosterSelection {
  const { roster } = input;
  if (!roster.restricted) return PASS_THROUGH;

  const label = roster.source === "roster" ? "profile roster" : "profile allowlist";
  if (roster.malformed) {
    return {
      ...PASS_THROUGH,
      holdReason: `${label} is set but unparseable — refusing to launch on an unrestricted profile`,
      note: `${label} unparseable; holding rather than falling back (fail closed)`,
    };
  }

  const requestedName = (input.profileName ?? "").trim();
  const requested: RosterEntry | null = requestedName
    ? { provider: narrowProvider(input.provider), name: requestedName, role: DEFAULT_PROFILE_ROLE }
    : null;

  // A forbidden profile is refused, never swapped — including when the request came from
  // an explicit workspace choice, a rotation-ring rewrite, or `--profile` on the CLI.
  if (requested && roleOf(roster, requested) === "forbidden") {
    const id = profileRefId(requested);
    return {
      ...PASS_THROUGH,
      refused: true,
      holdReason: `${id} is forbidden for this project — refusing rather than launching on another profile`,
      note: `${label}: ${id} is forbidden; refusing the launch (a forbidden profile is never clamped away)`,
    };
  }

  const exhaustedPct = input.exhaustedPct ?? DEFAULT_POOL_EXHAUSTED_PCT;
  const cooling = (e: RosterEntry): boolean => isProfileCooling(e, input.prefMap, input.nowMs);
  const exhausted = (e: RosterEntry): boolean => {
    const used = headroomOf(e, input.headroom);
    return used !== null && used >= exhaustedPct;
  };

  const pool = roster.entries.filter((e) => e.role === "pool");
  const poolRanked = rankRosterEntries(pool, input.headroom);
  const poolOrder = poolRanked.map(profileRefId);
  const usablePool = poolRanked.filter((e) => !cooling(e) && !exhausted(e));

  // The requested profile is permitted and usable — nothing to do. The common path once a
  // project is configured, so it must stay free of notes and log noise.
  if (requested && usablePool.some((e) => profileRefId(e) === profileRefId(requested))) {
    return { ...PASS_THROUGH, selection: { ...requested, role: "pool" }, poolOrder };
  }
  // An OPEN roster restricts nothing but the roles it NAMES, so a request for a profile it
  // has never heard of passes straight through, exactly as before rosters existed. A profile
  // the roster does list is subject to the roster — otherwise an exhausted pool entry would
  // escape through this door and the ordering above would be decorative.
  const listed = requested && roster.entries.some((e) => profileRefId(e) === profileRefId(requested));
  if (requested && !roster.closed && !listed && !cooling(requested) && !exhausted(requested)) {
    return { ...PASS_THROUGH, selection: { ...requested, role: "pool" }, poolOrder };
  }

  if (usablePool.length > 0) {
    const chosen = usablePool[0];
    return {
      ...PASS_THROUGH,
      selection: chosen,
      clamped: true,
      note: `${label}: ${clampReason(roster, requested, input, exhaustedPct)} → launching on ${profileOptionLabel(chosen.provider, chosen.name)}`,
      poolOrder,
    };
  }

  // Every pool profile is out. The reserve is the emergency supply, and reaching for it is
  // a decision someone has to have made — the flag, the ticket tag, or an explicit start.
  const reserve = rankRosterEntries(
    roster.entries.filter((e) => e.role === "reserve" && !cooling(e) && !exhausted(e)),
    input.headroom,
  );
  const poolDetail = pool.map((e) => describeEntry(e, input, exhaustedPct)).join(", ");
  if (reserve.length > 0) {
    if (!input.reserveAllowed) {
      return {
        ...PASS_THROUGH,
        holdReason:
          `every pool profile is exhausted or cooling (${poolDetail}) and reserve is not allowed for this project` +
          ` — set reserve_allowed_<projectId>, tag the ticket reserve:ok, or start it explicitly`,
        note: `${label}: reserve withheld; ${reserve.length} reserve profile(s) available but not permitted`,
        poolOrder,
      };
    }
    const chosen = reserve[0];
    const reserveNote =
      `${label}: RESERVE start on ${profileOptionLabel(chosen.provider, chosen.name)}` +
      ` — every pool profile is exhausted or cooling (${poolDetail || "no pool profile in this roster"})`;
    return {
      ...PASS_THROUGH,
      selection: chosen,
      clamped: !requested || profileRefId(requested) !== profileRefId(chosen),
      usedReserve: true,
      reserveNote,
      note: reserveNote,
      poolOrder,
    };
  }

  // Nothing left at all. An OPEN roster has no per-project restriction to enforce, so it
  // keeps today's behaviour (the caller's own selection) rather than inventing a hold.
  if (!roster.closed) {
    return { ...PASS_THROUGH, poolOrder };
  }
  const allCooling = roster.entries.every((e) => cooling(e) || e.role === "forbidden");
  const detail = roster.entries
    .filter((e) => e.role !== "forbidden")
    .map((e) => describeEntry(e, input, exhaustedPct))
    .join(", ");
  return {
    ...PASS_THROUGH,
    holdReason: allCooling
      ? `every allowed profile is cooling (${detail})`
      : `every pool profile is exhausted or cooling (${detail})`,
    note: `${label} exhausted: ${detail}`,
    poolOrder,
  };
}

function clampReason(
  roster: ParsedRoster,
  requested: RosterEntry | null,
  input: RosterSelectionInput,
  exhaustedPct: number,
): string {
  if (!requested) return "no profile resolved";
  const id = profileRefId(requested);
  const role = roleOf(roster, requested);
  if (role === "excluded") return `${id} is not allowed for this project`;
  if (role === "reserve") return `${id} is a reserve profile`;
  if (isProfileCooling(requested, input.prefMap, input.nowMs)) return `${id} is cooling`;
  const used = headroomOf(requested, input.headroom);
  if (used !== null && used >= exhaustedPct) return `${id} is exhausted (${used}% of the 5-hour window)`;
  return `${id} is not allowed for this project`;
}
