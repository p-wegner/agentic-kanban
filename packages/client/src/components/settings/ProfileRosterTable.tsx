/**
 * Settings → Agent: the GLOBAL profile roster (#1028).
 *
 * The roster (#1025), the observed roles (#1024) and the quota headroom (#1023) all landed
 * without a surface, so the operator questions they exist to answer — why did the start go
 * to that profile, why is this project holding, which account may never see this work — had
 * no place to be answered. This is that place: one row per known profile with its role, its
 * two window readings, when the 5-hour window resets, how old the measurement is, and
 * whether it is cooling.
 *
 * The role column is READ-ONLY on purpose, and the hint says so. The board does not own a
 * role — the account declares it in its own settings carrier and claude-pick owns that
 * lifecycle — so an editable control here would be a control the board could not honour.
 * Naming the command is the honest alternative to a disabled dropdown with no explanation.
 *
 * `unknown` quota is rendered as the word, never as a dash or a zero. A measurement older
 * than one reset window is neither exhausted nor empty, and a table that blurs the three is
 * worse than one with no numbers at all.
 */
import { useEffect, useRef } from "react";
import type { ProfileRosterProfile, ProfileRosterResponse } from "@agentic-kanban/shared/types";
import { useApiResource } from "../../hooks/useApiResource.js";
import {
  cooldownLabel,
  headroomLabel,
  measurementAgeLabel,
  resetLabel,
  roleBadgeClasses,
} from "../../lib/rosterEditor.js";

export function ProfileRosterTable({ roster, error, nowMs }: {
  roster: ProfileRosterResponse | null;
  error: string | null;
  /** Injected clock so the cooldown column is testable (`nowMs` spelling, #614). */
  nowMs?: number;
}) {
  const now = nowMs ?? Date.now();
  const profiles = roster?.profiles ?? [];

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Profile roster</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Every profile the board knows about, with the role its account declares for itself and its
          remaining quota. Roles are observed, never written by the board — change one with{" "}
          <span className="font-mono">{roster?.roleHintCommand ?? "claude-pick profile attr"}</span>.
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 text-xs text-red-600 dark:text-red-400 border-b border-gray-200 dark:border-gray-700">
          Roster unavailable — {error}
        </div>
      )}
      {roster?.quotaError && (
        <div className="px-3 py-2 text-xs text-amber-700 dark:text-amber-400 border-b border-gray-200 dark:border-gray-700">
          Quota source unavailable — {roster.quotaError}. Roles and cooldowns below are still accurate;
          headroom reads <span className="font-mono">unknown</span>, which is never treated as exhausted.
        </div>
      )}
      {profiles.length === 0 ? (
        <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
          {error ? "No roster to show." : "No profiles discovered on this machine."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-100 dark:border-gray-800">
                <th className="px-3 py-1.5 font-medium">Profile</th>
                <th className="px-3 py-1.5 font-medium">Role</th>
                <th className="px-3 py-1.5 font-medium" title="Percent of the 5-hour window used">5h</th>
                <th className="px-3 py-1.5 font-medium" title="Percent of the 7-day window used">7d</th>
                <th className="px-3 py-1.5 font-medium">Resets</th>
                <th className="px-3 py-1.5 font-medium">Measured</th>
                <th className="px-3 py-1.5 font-medium">Cooldown</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {profiles.map((p) => <ProfileRosterRow key={p.id} profile={p} nowMs={now} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProfileRosterRow({ profile, nowMs }: { profile: ProfileRosterProfile; nowMs: number }) {
  const unknown = profile.quota.stale || profile.quota.status === "unknown";
  return (
    <tr className="text-gray-700 dark:text-gray-200">
      <td className="px-3 py-1.5">
        <span className="font-mono">{profile.id}</span>
        {!profile.loggedIn && (
          <span className="ml-1.5 text-amber-600 dark:text-amber-400" title="No usable credentials on this machine">not logged in</span>
        )}
        {profile.dedicatedProject && (
          <span className="ml-1.5 text-gray-500 dark:text-gray-400" title="KANBAN_PROFILE_DEDICATED — forbidden for every other project">
            dedicated: {profile.dedicatedProject}
          </span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <span className={`px-1.5 py-0.5 rounded ${roleBadgeClasses(profile.role)}`}>{profile.role}</span>
        {profile.roleConflict && (
          <span
            className="ml-1.5 text-red-600 dark:text-red-400"
            title={`Machines disagree: ${profile.conflictingRoles.join(", ")}. The most restrictive role won.`}
          >
            role conflict
          </span>
        )}
      </td>
      <td className={`px-3 py-1.5 tabular-nums${unknown ? " italic text-gray-400 dark:text-gray-500" : ""}`}>
        {headroomLabel(profile.quota.usedPct5h, unknown)}
      </td>
      <td className={`px-3 py-1.5 tabular-nums${unknown ? " italic text-gray-400 dark:text-gray-500" : ""}`}>
        {headroomLabel(profile.quota.usedPct7d, unknown)}
      </td>
      <td className="px-3 py-1.5 tabular-nums">{resetLabel(profile.quota.resetAt5h)}</td>
      <td
        className="px-3 py-1.5 tabular-nums"
        title={unknown ? "Older than one reset window — counted as unknown, never as exhausted" : `Measured ${profile.quota.measuredAt ?? "—"}`}
      >
        {measurementAgeLabel(profile.quota.ageSeconds)}
      </td>
      <td className="px-3 py-1.5 tabular-nums">{cooldownLabel(profile.coolingUntil, nowMs)}</td>
    </tr>
  );
}

/**
 * Fetch the roster once. Its own data source, like `ProfileQuotaSection` — the Settings
 * panel's bootstrap is a settings blob, and joining a filesystem walk plus a quota call into
 * it would slow the first paint of every tab for one table on one of them.
 *
 * On `useApiResource` (#513), not a hand-rolled ladder: #1028 shipped its own
 * data/error/cancelled effect here and `fetch-in-effect-ratchet.test.ts` — a DOWN-only ring —
 * went red for it (#1034). The hook is the ladder, so this file has none.
 *
 * `reloadKey` stays in the signature because the caller bumps it after a roster SAVE, which is
 * not a path change; it is translated into the hook's own `reload()` on change only, so a first
 * render with an already-nonzero key does not fetch twice.
 */
export function useProfileRoster(projectId?: string | null, reloadKey = 0) {
  // The `?` stays INSIDE the literal so the path is still readable to the response-
  // validation ratchet's scanner — an interpolation that starts where the path ends makes
  // the endpoint invisible to it, and an endpoint it cannot see is one it cannot check.
  const path = `/api/profile-roster?projectId=${encodeURIComponent(projectId ?? "")}`;
  const { data: roster, error, reload } = useApiResource<ProfileRosterResponse>(path, {
    fallbackError: "unavailable",
  });

  const seenReloadKey = useRef(reloadKey);
  useEffect(() => {
    if (seenReloadKey.current === reloadKey) return;
    seenReloadKey.current = reloadKey;
    reload();
  }, [reloadKey, reload]);

  return { roster, error };
}
