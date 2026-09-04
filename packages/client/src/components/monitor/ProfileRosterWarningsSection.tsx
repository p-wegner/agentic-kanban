/**
 * Monitor view: the two roster conditions that are not failures and must still be SEEN
 * (#1028).
 *
 * Both are invisible by construction otherwise. A **reserve start** is a successful launch —
 * nothing errors, nothing holds, the work proceeds — and the only trace is one log line; an
 * emergency account spent silently is one spent by accident. A **cross-machine role
 * conflict** is already resolved (the more restrictive role wins), which is exactly why it
 * needs surfacing: without it, an account someone set to `pool` on this machine behaves as
 * `forbidden` and nothing on the board ever says why.
 *
 * Amber, not red, and deliberately: neither condition is broken. The red `MonitorWarnings`
 * banner is for a monitor that cannot do its job; this is the board telling an operator
 * something they would want to know. Rendering it red would train them to ignore red.
 *
 * Its own module with its own fetch, like `ProfileQuotaSection` — `MonitorSections.tsx` is
 * at 943 of the 1000-line god-module ceiling, and this section owns a data source that file
 * has no other reason to know about.
 */
import type { ProfileRosterResponse } from "@agentic-kanban/shared/types";
import { useProfileRoster } from "../settings/ProfileRosterTable.js";
import { conflictingProfiles } from "../../lib/rosterEditor.js";

export function ProfileRosterWarningsSection({ projectId }: { projectId?: string | null }) {
  const { roster } = useProfileRoster(projectId);
  return <ProfileRosterWarningsBody roster={roster} />;
}

/**
 * The pure half (`*Body`, #611) — exported so the section can be asserted without a fetch.
 */
export function ProfileRosterWarningsBody({ roster }: { roster: ProfileRosterResponse | null }) {
  const conflicts = conflictingProfiles(roster?.profiles ?? []);
  const selection = roster?.project?.selection ?? null;
  const reserve = selection?.usedReserve ? selection : null;
  // Nothing to say is said by saying nothing: an always-present empty section is noise in a
  // popover whose other sections already appear only when they have content.
  if (conflicts.length === 0 && !reserve) return null;

  return (
    <div className="px-3 py-2.5 border-b border-amber-100 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/25">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300 mb-1.5">
        Profile roster
      </div>
      <div className="space-y-2">
        {reserve && (
          <div className="text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
            <div className="font-semibold">
              Reserve start: <span className="font-mono">{selection?.profileId}</span>
            </div>
            <div>{reserve.reserveNote ?? "Every pool profile is exhausted or cooling."}</div>
          </div>
        )}
        {conflicts.map((p) => (
          <div key={p.id} className="text-[11px] text-amber-800 dark:text-amber-200 leading-snug">
            <div className="font-semibold">
              Role conflict on <span className="font-mono">{p.id}</span>
              {p.conflictingRoles.length > 0 ? ` — ${p.conflictingRoles.join(" vs ")}` : ""}
            </div>
            <div>
              {p.roleWarnings.length > 0
                ? p.roleWarnings.join(" ")
                : `Machines disagree about this account's role; "${p.role}" won because the roster always takes the most restrictive.`}
            </div>
          </div>
        ))}
      </div>
      {roster?.roleHintCommand && (
        <div className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          Roles live on the account, not on the board — change one with{" "}
          <span className="font-mono">{roster.roleHintCommand}</span>.
        </div>
      )}
    </div>
  );
}
