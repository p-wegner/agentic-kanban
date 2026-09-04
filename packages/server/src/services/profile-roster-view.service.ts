/**
 * The roster READ MODEL (#1028): the one place that joins what #1025 decides with what
 * #1023 measures and what #1024 observed, so a UI can render it in one request.
 *
 * It composes and formats; it decides nothing. Every judgement — which role a profile
 * carries, how the pool is ordered, whether the project holds, whether a start is a reserve
 * start — comes back from `loadProjectRuntimeConfig`, i.e. from the SAME resolver a real
 * launch goes through. That is the whole point: a "why this profile" panel computed from a
 * second, parallel reading of the rules is a panel that can be confidently wrong, and the
 * roster's value is that exactly one place applies the narrowing rule.
 *
 * Two deliberate omissions:
 *  - `projectSlug` is NOT passed to the resolver, because no production launch path passes
 *    one either. Feeding one here would make the preview disagree with the launch it is
 *    supposed to explain; `dedicatedProject` is surfaced on the row instead, so an operator
 *    can see the constraint without the preview inventing an answer about it.
 *  - The reserve grants that are per-LAUNCH (the `reserve:ok` ticket tag, an explicit
 *    operator start) are not simulated. The preview answers "what would this project do on
 *    its own standing configuration", which is the question a settings/monitor panel can
 *    actually answer.
 */
import type { Database } from "../db/index.js";
import type {
  ProfileRosterProfile,
  ProfileRosterProject,
  ProfileRosterQuota,
  ProfileRosterResponse,
} from "@agentic-kanban/shared/types";
import type { QuotaProviderEntry, QuotaUsageResult } from "@agentic-kanban/shared";
import {
  headroomFromQuotaUsage,
  mostRestrictiveRole,
  profileCooldownKey,
  profileRefId,
  resolvePoolExhaustedPct,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CODEX_LICENSE_RING } from "../constants/preference-keys.js";
import { loadObservedRosterDetails } from "./profile-roster.service.js";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { fetchLiveQuotaUsage } from "../services/quota-usage.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * The board reads roles and never writes them, so the UI's "how do I change this?" has to
 * point at the tool that owns their lifecycle rather than at a control the board could not
 * honour (proposal §6, "claude-pick besitzt den Lebenszyklus der Attribute").
 */
export const ROLE_HINT_COMMAND = "claude-pick profile attr <profile> --role pool|reserve|forbidden";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export interface ProfileRosterViewInput {
  projectId?: string | null;
  /** Injected clock (`nowMs` spelling, #614). */
  nowMs?: number;
  /** Injected quota source, so a route test needs no live OAuth call. */
  fetchQuota?: () => Promise<QuotaUsageResult>;
}

/** The 5-hour and 7-day readings for one profile, or the `none` row when nothing knows it. */
function quotaFor(entry: QuotaProviderEntry | undefined): ProfileRosterQuota {
  if (!entry) {
    return { status: "none", usedPct5h: null, usedPct7d: null, resetAt5h: null, measuredAt: null, ageSeconds: null, stale: false };
  }
  const metric = (label: RegExp, periodMs?: number) =>
    (entry.metrics ?? []).find((m) => (periodMs != null && m.periodMs === periodMs) || label.test(m.label ?? ""));
  const five = metric(/5[\s-]?h/i, FIVE_HOURS_MS);
  const seven = metric(/7[\s-]?d/i);
  const stale = entry.stale === true || entry.status === "unknown";
  return {
    status: entry.status,
    // A stale reading describes a window that has since reset, so it is reported as
    // absent rather than as a number — the #1023 rule, and the reason the roster never
    // reads `unknown` as exhausted.
    usedPct5h: stale ? null : five?.percent ?? null,
    usedPct7d: stale ? null : seven?.percent ?? null,
    resetAt5h: five?.resetIso ?? null,
    measuredAt: entry.measuredAt ?? null,
    ageSeconds: entry.ageSeconds ?? null,
    stale,
  };
}

/** The whole read model for one request. */
export async function buildProfileRosterView(
  database: Database,
  input: ProfileRosterViewInput = {},
): Promise<ProfileRosterResponse> {
  const nowMs = input.nowMs ?? Date.now();
  const prefMap = toPrefMap(await getAllPreferences(database));

  let quota: QuotaUsageResult | null = null;
  let quotaError: string | null = null;
  try {
    quota = await (input.fetchQuota ?? fetchLiveQuotaUsage)();
  } catch (err) {
    // The table still renders. Roles, conflicts and cooldowns do not depend on the quota
    // source, and hiding them because a number is missing would remove the half of the
    // answer that is always available.
    quotaError = errorMessage(err);
  }
  const quotaById = new Map((quota?.providers ?? []).map((p) => [p.id, p]));

  const observed = loadObservedRosterDetails({
    claudeRingRaw: prefMap.get(PREF_CLAUDE_SUBSCRIPTION_RING),
    codexRingRaw: prefMap.get(PREF_CODEX_LICENSE_RING),
    nowMs,
  });

  const profiles: ProfileRosterProfile[] = observed.map((row) => {
    const id = profileRefId(row);
    const coolingStamp = prefMap.get(profileCooldownKey(row.provider, row.name)) ?? null;
    const until = coolingStamp ? Date.parse(coolingStamp) : Number.NaN;
    return {
      id,
      provider: row.provider,
      name: row.name,
      role: row.role,
      dedicatedProject: row.dedicatedProject ?? null,
      roleObservedAt: row.roleObservedAt,
      roleConflict: row.roleConflict,
      conflictingRoles: row.conflictingRoles,
      roleWarnings: row.roleWarnings,
      loggedIn: row.loggedIn,
      inRing: row.inRing,
      // Only a stamp still in the future is a cooldown; an elapsed or unparseable one is
      // not, which mirrors `isProfileCooling` rather than restating it differently.
      coolingUntil: Number.isFinite(until) && until > nowMs ? coolingStamp : null,
      // The quota source identifies a Claude profile by its bare name; a roster entry is
      // always provider-qualified. Try both spellings so a match is not lost to a spelling.
      quota: quotaFor(quotaById.get(id) ?? quotaById.get(row.name)),
    };
  });

  return {
    profiles,
    project: input.projectId ? await buildProjectHalf(database, input.projectId, observed, quota, prefMap, nowMs) : null,
    quotaError,
    roleHintCommand: ROLE_HINT_COMMAND,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

async function buildProjectHalf(
  database: Database,
  projectId: string,
  observed: ReturnType<typeof loadObservedRosterDetails>,
  quota: QuotaUsageResult | null,
  prefMap: Map<string, string>,
  nowMs: number,
): Promise<ProfileRosterProject | null> {
  const project = await getProjectById(projectId, database);
  if (!project) return null;

  const runtime = await loadProjectRuntimeConfig(database, {
    projectId,
    globalRoster: observed,
    headroom: headroomFromQuotaUsage(quota),
    nowMs,
  });
  const roster = runtime.provider.roster;
  const globalRole = new Map(observed.map((e) => [profileRefId(e), e.role] as const));
  const selected = runtime.provider.profileSelection;

  return {
    projectId,
    projectName: project.name,
    entries: roster.entries.map((e) => {
      const id = profileRefId(e);
      return {
        id,
        provider: e.provider,
        name: e.name,
        role: e.role,
        // What the ACCOUNT declares — the floor the project may narrow from but not past.
        // `mostRestrictiveRole` is applied for the same reason the resolver applies it: an
        // entry the global roster has never heard of has no floor beyond `pool`.
        globalRole: mostRestrictiveRole(globalRole.get(id) ?? "pool", "pool"),
      };
    }),
    restricted: roster.restricted,
    closed: roster.closed,
    malformed: roster.malformed,
    source: roster.source,
    reserveAllowed: runtime.provider.reserveAllowed,
    exhaustedPct: resolvePoolExhaustedPct(prefMap, projectId),
    selection: {
      profileId: selected ? profileRefId(selected) : null,
      usedReserve: runtime.provider.reserveUsed,
      reserveNote: runtime.provider.reserveNote,
      holdReason: runtime.provider.profileHold,
      refused: runtime.provider.profileRefused,
      poolOrder: runtime.provider.poolOrder,
    },
  };
}
