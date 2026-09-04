/**
 * WHY this session launched on THIS profile (#1026).
 *
 * #801 gave a session row `placement_reason`/`placement_detail` because a live
 * re-derivation can never answer a historical question — the preferences, the fleet and
 * the quota have all moved since. Profile selection has exactly the same property, and one
 * more reason to be recorded: since #1026 the choice can be made by MEASURED 5-hour
 * headroom, so "why not the other account" is a number that existed for a few minutes and
 * is then gone. A record written at the moment of the decision is the only place it
 * survives.
 *
 * The record is deliberately small and self-describing: the profile, its reading, what
 * decided, and every candidate that was considered with the reading that lost. It is
 * stored as JSON in ONE nullable column rather than as a column family, because nothing
 * queries it — it is read back by a human (or an agent) asking about one session.
 *
 * Client-safe: no node imports, so the Monitor view can render the same parse the writer
 * produced.
 */

/** What happened to one candidate profile in this decision. */
export type ProfileSelectionOutcome =
  /** The profile this session launched on. */
  | "selected"
  /** At or over the project's 5-hour exhaustion threshold BEFORE the start (#1026). */
  | "exhausted"
  /** Cooling under a rotation-ring cooldown stamp. */
  | "cooling"
  /** Permitted and usable, but another candidate ranked ahead of it. */
  | "available";

export interface ProfileSelectionCandidate {
  /** `provider:name`. */
  id: string;
  /** Percent of the 5-hour window USED, or null when nothing was measured. */
  usedPct: number | null;
  outcome: ProfileSelectionOutcome;
}

/**
 * What actually decided. `headroom` is the #1026 case and the only one that needed a new
 * mechanism; the others are named so a reader can tell "the numbers chose" apart from
 * "there was only ever one candidate", which look identical in the outcome alone.
 */
export type ProfileSelectionDecidedBy =
  /** More than one candidate was usable and the measured headroom ranked them. */
  | "headroom"
  /** No usable measurement — the Bullseye's / roster's declared order decided, as before. */
  | "list-order"
  /** An explicit, healthy choice (per-workspace profile, legacy override) was kept. */
  | "explicit"
  /** The roster overrode what the precedence chain produced. */
  | "clamped"
  /** Every pool profile was out and a `reserve` profile was permitted. */
  | "reserve";

export interface ProfileSelectionReason {
  /** `provider:name` of the profile this session launched on. */
  profile: string;
  /** The selected profile's own 5-hour reading, or null when unmeasured. */
  usedPct: number | null;
  /** Which selector produced the request (`RuntimeProviderConfig["source"]`). */
  source: string;
  decidedBy: ProfileSelectionDecidedBy;
  /** One line, already phrased for a log or a tooltip. */
  summary: string;
  /** Every candidate considered, in the order they were considered. */
  candidates: ProfileSelectionCandidate[];
}

export interface ProfileSelectionReasonInput {
  /** `provider:name` of the selected profile. Absent ⇒ no record (nothing was selected). */
  selected: string | null | undefined;
  source: string;
  /** Considered candidates, in consideration order, with their readings. */
  candidates: ReadonlyArray<{ id: string; usedPct: number | null; cooling?: boolean; exhausted?: boolean }>;
  clamped?: boolean;
  reserveUsed?: boolean;
  /**
   * The selector NAMED one profile rather than ranking a pool (an explicit per-workspace
   * choice, a baked workspace selection, the global settings default). Reported as
   * `explicit` even when readings exist, because the readings did not decide — calling a
   * kept choice "headroom" would credit a decision nothing made.
   */
  explicit?: boolean;
  /** The roster/allowlist note or the strategy note, when the caller has one. */
  note?: string | null;
}

function pct(value: number | null): string {
  return value === null ? "unmeasured" : `${value}% used`;
}

/**
 * Build the record. Returns null when there is nothing to record — a session whose profile
 * was never resolved here keeps a NULL column, exactly as #801 keeps "not recorded"
 * distinct from "the default happened".
 */
export function buildProfileSelectionReason(
  input: ProfileSelectionReasonInput,
): ProfileSelectionReason | null {
  const selected = (input.selected ?? "").trim();
  if (!selected) return null;

  const candidates: ProfileSelectionCandidate[] = input.candidates.map((c) => ({
    id: c.id,
    usedPct: c.usedPct,
    outcome:
      c.id === selected
        ? "selected"
        : c.cooling
          ? "cooling"
          : c.exhausted
            ? "exhausted"
            : "available",
  }));
  if (!candidates.some((c) => c.id === selected)) {
    // The selection came from outside the candidate list (an explicit profile the roster
    // never listed). Record it anyway — a record that omits the winner is worse than none.
    candidates.unshift({ id: selected, usedPct: null, outcome: "selected" });
  }
  const selectedUsedPct = candidates.find((c) => c.id === selected)?.usedPct ?? null;

  const decidedBy: ProfileSelectionDecidedBy = input.reserveUsed
    ? "reserve"
    : input.clamped
      ? "clamped"
      : input.explicit
        ? "explicit"
      // Headroom only DECIDED when there was a real choice AND a measurement to make it
      // with — ruling a candidate out as exhausted counts, since that is the reading
      // deciding too. One candidate, or none measured, is list order; calling that
      // "headroom" would report a decision nothing actually made.
      : candidates.length > 1 && candidates.some((c) => c.usedPct !== null)
        ? "headroom"
        : candidates.length > 1
          ? "list-order"
          : "explicit";

  const losers = candidates.filter((c) => c.outcome !== "selected");
  const loserText = losers.length
    ? ` (over ${losers
        .map((c) => `${c.id} ${c.outcome === "available" ? pct(c.usedPct) : `${c.outcome}, ${pct(c.usedPct)}`}`)
        .join("; ")})`
    : "";
  const summary =
    `${selected} at ${pct(selectedUsedPct)} — chosen by ${decidedBy} from ${input.source}${loserText}` +
    (input.note ? ` — ${input.note}` : "");

  return { profile: selected, usedPct: selectedUsedPct, source: input.source, decidedBy, summary, candidates };
}

/** JSON for the `sessions.profile_selection_reason` column. */
export function serializeProfileSelectionReason(reason: ProfileSelectionReason | null): string | null {
  return reason ? JSON.stringify(reason) : null;
}

/** Read one back. Never throws: an unparseable/older value reads as "not recorded". */
export function parseProfileSelectionReason(raw: string | null | undefined): ProfileSelectionReason | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProfileSelectionReason>;
    if (!parsed || typeof parsed.profile !== "string" || !parsed.profile) return null;
    return {
      profile: parsed.profile,
      usedPct: typeof parsed.usedPct === "number" ? parsed.usedPct : null,
      source: typeof parsed.source === "string" ? parsed.source : "unknown",
      decidedBy: (parsed.decidedBy ?? "list-order") as ProfileSelectionDecidedBy,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      candidates: Array.isArray(parsed.candidates) ? (parsed.candidates as ProfileSelectionCandidate[]) : [],
    };
  } catch {
    return null;
  }
}
