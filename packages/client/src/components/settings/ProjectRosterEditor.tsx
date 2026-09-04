/**
 * Settings → Agent: the PER-PROJECT roster editor (#1028).
 *
 * This REPLACES the "Profiles this project may use" checkbox list rather than sitting beside
 * it. Two editors over one stored value is how an operator ends up with a screen that says
 * one thing and a resolver that does another — and the allowlist is not a separate feature
 * any more, it is the roster with every role at `pool` (#1025 made that a read-time
 * projection). A tick becomes a role, and the checkbox's meaning is preserved exactly: a
 * profile set to `pool` is a profile the project may use.
 *
 * The narrowing rule is enforced HERE as well as on the server, and both halves are wanted.
 * The dropdown simply does not offer a role above the one the account declares, which is the
 * usable interface; the server guard is what makes it true for a hand-edited preference, a
 * config import, or the CLI. Neither is redundant — a UI that only *looks* correct and a
 * rejection with no explanation are different failures.
 */
import type { ProfileRole } from "@agentic-kanban/shared/lib/profile-allowlist";
import type { ProfileRosterProject } from "@agentic-kanban/shared/types";
import { Field } from "../SettingsPanel.shared.js";
import {
  allowedRolesFor,
  roleBadgeClasses,
  type RosterCandidate,
  type RosterDraftEntry,
} from "../../lib/rosterEditor.js";

// Declared in `lib/rosterEditor.ts` so `hooks/` can name it without an upward edge (#1034);
// re-exported here because this is where its importers already look.
export type { RosterCandidate };


/** The sentinel for "this project may not use this profile at all" (absent from the roster). */
const UNLISTED = "";

export interface ProjectRosterEditorProps {
  candidates: RosterCandidate[];
  /** The project's own roster, as stored. Empty = unrestricted. */
  entries: RosterDraftEntry[];
  onRoleChange: (candidate: RosterCandidate, role: ProfileRole | null) => void;
  reserveAllowed: boolean;
  onReserveAllowedChange: (allowed: boolean) => void;
  exhaustedPct: number;
  onExhaustedPctChange: (pct: number) => void;
  /** The resolved project half, for the "what would happen right now" line. */
  project: ProfileRosterProject | null;
  saving?: boolean;
  /** The last refused widening, so a rejection is explained rather than silently ignored. */
  rejection?: string | null;
}

export function ProjectRosterEditor(props: ProjectRosterEditorProps) {
  const { candidates, entries, project, saving, rejection } = props;
  const roleById = new Map<string, ProfileRole>(entries.map((e) => [`${e.provider}:${e.name}`, e.role]));
  const listed = entries.length;

  return (
    <Field
      label="Profile roster for this project"
      hint="A hard restriction, not a default. Leave every profile unlisted to allow any of them (the normal case). List one or more and this project can ONLY launch on those: pool is ordinary supply (picked by remaining 5-hour headroom), reserve is the emergency account (only when every pool profile is exhausted or cooling AND reserve is allowed below), forbidden is refused outright. A role can only be narrowed — the account's own role is the ceiling."
    >
      {rejection && (
        <div className="mb-2 px-2.5 py-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-[11px] text-red-700 dark:text-red-300">
          {rejection}
        </div>
      )}
      <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {candidates.length === 0 && (
          <div className="text-[11px] text-gray-500 dark:text-gray-400">No profiles discovered on this machine.</div>
        )}
        {candidates.map((candidate) => {
          const current = roleById.get(candidate.id) ?? null;
          const options = allowedRolesFor(candidate.globalRole);
          return (
            <div key={candidate.id} className="flex items-center gap-2 text-sm">
              <select
                value={current ?? UNLISTED}
                disabled={saving}
                aria-label={`Role for ${candidate.id}`}
                onChange={(e) => props.onRoleChange(candidate, e.target.value === UNLISTED ? null : (e.target.value as ProfileRole))}
                className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
              >
                <option value={UNLISTED}>not listed</option>
                {options.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              <span className="font-mono text-xs">{candidate.id}</span>
              {/* The account's own role, shown whenever it already narrows the choice — this
                  is the reason an option is missing, and an absent option with no reason is
                  what makes a UI look broken. */}
              {candidate.globalRole !== "pool" && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${roleBadgeClasses(candidate.globalRole)}`}
                  title="Declared by the account itself — this project cannot widen it"
                >
                  globally {candidate.globalRole}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400">
        {listed === 0
          ? "Unrestricted — this project may launch on any profile whose account does not forbid it."
          : `Restricted to ${listed} profile${listed === 1 ? "" : "s"}. Launches outside the roster are refused.`}
      </p>

      <label className="mt-2.5 flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={props.reserveAllowed}
          disabled={saving}
          onChange={(e) => props.onReserveAllowedChange(e.target.checked)}
          className="rounded border-gray-300 dark:border-gray-600 disabled:opacity-50"
        />
        <span className="text-xs">Allow this project to reach for a reserve profile</span>
      </label>
      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
        Only ever used when every pool profile is exhausted or cooling. A single ticket can be granted
        it instead with the <span className="font-mono">reserve:ok</span> tag, and an explicit operator
        start always may. Every reserve start is logged and shown in the Monitor view.
      </p>

      <div className="mt-2.5 flex items-center gap-2">
        <label className="text-xs text-gray-600 dark:text-gray-300" htmlFor="roster-exhausted-pct">
          Pool exhausted at
        </label>
        <input
          id="roster-exhausted-pct"
          type="number"
          min={1}
          max={100}
          value={props.exhaustedPct}
          disabled={saving}
          onChange={(e) => props.onExhaustedPctChange(Number(e.target.value))}
          className="w-20 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
        />
        <span className="text-xs text-gray-500 dark:text-gray-400">% of the 5-hour window</span>
      </div>

      {project && <RosterSelectionLine project={project} />}
    </Field>
  );
}

/**
 * What the roster would do right now. The point of the whole screen is "why did it pick
 * that one", so the answer belongs beside the controls rather than only in a log line.
 */
function RosterSelectionLine({ project }: { project: ProfileRosterProject }) {
  const { selection } = project;
  if (project.malformed) {
    return (
      <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
        This project's stored roster is unparseable, so every launch HOLDS (it fails closed). Re-save it above.
      </p>
    );
  }
  if (selection.holdReason) {
    return (
      <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
        {selection.refused ? "Would refuse" : "Would hold"} right now — {selection.holdReason}
      </p>
    );
  }
  if (!selection.profileId) {
    return (
      <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
        No restriction in force — the usual provider selection applies.
      </p>
    );
  }
  return (
    <p className={`mt-2 text-[11px] ${selection.usedReserve ? "text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-gray-400"}`}>
      Would launch on <span className="font-mono">{selection.profileId}</span>
      {selection.usedReserve ? " — a RESERVE start" : ""}
      {selection.poolOrder.length > 0 ? ` (pool order: ${selection.poolOrder.join(" → ")})` : ""}
    </p>
  );
}
