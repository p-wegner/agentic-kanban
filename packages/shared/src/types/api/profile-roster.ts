// Profile-roster wire-contract types (pure DTOs). See ../api.ts barrel.
//
// #1028 — the READ side of the roster (#1025). The roster's three roles, the headroom that
// orders the pool, the cooldown that takes a profile out, and the observed role conflicts
// all existed as of #1025 and none of them were visible anywhere: an operator could see
// that a launch went to profile X, or that a project held, and had no way to ask why.
//
// One endpoint answers all of it, because the answer is a JOIN and doing it in the client
// would mean three round trips and a fourth reader of the roster rules. The GLOBAL half
// (`profiles`) is what the board OBSERVED (#1024, projected by `profile-roster.service.ts`)
// joined with the #1023 quota reading and the rotation ring's cooldown stamps. The PROJECT
// half (`project`) is the narrowed roster plus the selection that roster would make right
// now — which is what turns "why this profile" into a rendered sentence rather than a log
// line nobody reads.
//
// Roles are never WRITTEN through this contract. The board does not own them (the account
// declares its own role in its settings carrier, and claude-pick owns that lifecycle), so
// `roleHintCommand` carries the command an operator actually has to run instead of a
// control that would imply the board could change it.
import type { ProfileRole } from "../../lib/profile-roster.js";

/** The quota reading for one profile, flattened to what a table row shows. */
export interface ProfileRosterQuota {
  /**
   * `none` means the quota source knows nothing about this profile at all (a Codex
   * license, say). It is deliberately distinct from `unknown`, which means the source
   * knows the profile and its measurement is older than one reset window — the #1023
   * distinction that must never read as "exhausted".
   */
  status: "ok" | "auth" | "error" | "unknown" | "none";
  /** Percent of the 5-hour window USED, or null when nothing usable was measured. */
  usedPct5h: number | null;
  /** Percent of the 7-day window USED, or null. */
  usedPct7d: number | null;
  /** ISO instant the 5-hour window resets, or null when unknown. */
  resetAt5h: string | null;
  /** ISO instant the reading was taken; null if never. */
  measuredAt: string | null;
  /** Age of that reading in seconds; null if never measured. */
  ageSeconds: number | null;
  /** The reading is older than one reset window (or was never taken). */
  stale: boolean;
}

/** One profile in the GLOBAL roster: identity, the role it declares, and its headroom. */
export interface ProfileRosterProfile {
  /** `provider:name` — the identity the roster, the cooldown stamps and the UI all key by. */
  id: string;
  provider: string;
  name: string;
  /** The role the ACCOUNT declares for itself. Read-only here — the board never writes it. */
  role: ProfileRole;
  /** `KANBAN_PROFILE_DEDICATED` — forbidden everywhere except this project slug. */
  dedicatedProject: string | null;
  /** ISO stamp of the newest contributing observation; null when nothing declared anything. */
  roleObservedAt: string | null;
  /** Two carriers/machines disagreed about this profile — the more restrictive role won. */
  roleConflict: boolean;
  /** The distinct roles seen when `roleConflict`; empty otherwise. */
  conflictingRoles: ProfileRole[];
  /** Unknown role values and conflict detail, verbatim from discovery. */
  roleWarnings: string[];
  /** The profile has usable credentials on this machine. */
  loggedIn: boolean;
  /** Currently part of its provider's rotation ring. */
  inRing: boolean;
  /** ISO instant the rotation ring's cooldown expires, or null when not cooling. */
  coolingUntil: string | null;
  quota: ProfileRosterQuota;
}

/** One profile as this PROJECT sees it: the observed role narrowed by the project roster. */
export interface ProfileRosterProjectEntry {
  id: string;
  provider: string;
  name: string;
  /** The effective role for this project (`mostRestrictiveRole` of global and project). */
  role: ProfileRole;
  /** The globally observed role, so the UI can show what may still be narrowed. */
  globalRole: ProfileRole;
}

/**
 * What the roster would decide for this project RIGHT NOW. Not a prediction of a specific
 * launch — the ticket tag and an explicit operator start are two of the three reserve
 * grants and neither exists outside a launch — but it is the same selection function, so a
 * reserve start or a hold shows up here before someone spends an emergency account.
 */
export interface ProfileRosterSelectionPreview {
  /** `provider:name` the roster would select, or null when it permits nothing. */
  profileId: string | null;
  /** The selection is a `reserve` profile — the Monitor view's warning. */
  usedReserve: boolean;
  /** The reserve start spelled out, when `usedReserve`. */
  reserveNote: string | null;
  /** Why nothing may launch; null whenever `profileId` is non-null. */
  holdReason: string | null;
  /** A `forbidden` profile was requested — a refusal, not a substitution. */
  refused: boolean;
  /** The pool in the order it was considered — the "why this one" trail. */
  poolOrder: string[];
}

/** The per-project half: the narrowed roster, its grants, and what it would select. */
export interface ProfileRosterProject {
  projectId: string;
  /** Present only when the project was found; null for an unknown id. */
  projectName: string | null;
  entries: ProfileRosterProjectEntry[];
  /** A restriction is in force at all. */
  restricted: boolean;
  /** Only the listed profiles may be used (a project roster or a legacy allowlist). */
  closed: boolean;
  /** The stored value is present but unparseable — the roster fails CLOSED. */
  malformed: boolean;
  /** Which stored value the project roster came from. */
  source: "none" | "allowed_profiles" | "roster";
  /** `reserve_allowed_<projectId>` — may this project reach for a reserve profile? */
  reserveAllowed: boolean;
  /** Percent of the 5-hour window at which a pool profile counts as exhausted. */
  exhaustedPct: number;
  selection: ProfileRosterSelectionPreview;
}

/** `GET /api/profile-roster[?projectId=…]`. */
export interface ProfileRosterResponse {
  profiles: ProfileRosterProfile[];
  /** Null unless `projectId` was given and could be resolved. */
  project: ProfileRosterProject | null;
  /**
   * The quota source failed. The roster still renders — an `unknown` reading is the
   * designed degradation, and hiding the table because a number is missing would remove
   * exactly the roles and conflicts that do not depend on it.
   */
  quotaError: string | null;
  /** The claude-pick command that CHANGES a role, since the board only reads them. */
  roleHintCommand: string;
  generatedAt: string;
}
