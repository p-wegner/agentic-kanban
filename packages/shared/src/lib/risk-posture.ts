import { projectPref } from "./dynamic-preference-keys.js";

/**
 * Risk posture (#912, following #911's sequencing): one per-project dial that
 * resolves to a bundle of downstream settings, replacing the "hand-align 8
 * prefs" problem described in docs/proposals/2026-08-25-risk-posture-and-merge-train.md
 * §3. This module owns the RESOLVER — the single function every consumer (the
 * generated objective.md block, `resolveMonitorTunables`, the ticket-context
 * file, the settings UI, the header chip) reads instead of re-deriving the four
 * levels itself.
 *
 * The honesty rule from the proposal: a weaker posture may only weaken
 * verification VISIBLY. `RISK_POSTURE_DESCRIPTIONS` is the one-line "what this
 * skips" text shown next to the selector and in the chip tooltip — every
 * consumer that renders a posture should quote this text rather than inventing
 * its own summary, so the disclosure stays consistent everywhere it appears.
 */
export const RISK_POSTURES = ["strict", "standard", "iterate", "fast", "sprint"] as const;
export type RiskPosture = (typeof RISK_POSTURES)[number];

export const riskPosturePref = projectPref("risk_posture");

export const RISK_POSTURE_DEFAULT: RiskPosture = "standard";

export const RISK_POSTURE_LABELS: Record<RiskPosture, string> = {
  strict: "Strict",
  standard: "Standard",
  iterate: "Iterate",
  fast: "Fast",
  sprint: "Sprint",
};

/**
 * One-line "what this posture skips" — kept in sync with the four-level table in
 * docs/proposals/2026-08-25-risk-posture-and-merge-train.md §3. Shown beside the
 * settings selector and in the header chip tooltip.
 */
export const RISK_POSTURE_DESCRIPTIONS: Record<RiskPosture, string> = {
  strict: "Skips nothing — thorough per-ticket review, full pre-merge gate, no red base ever, no train batching. For release branches and client repos with allowlists.",
  standard: "Today's default — scoped per-ticket review and gate, red base always blocks merge. No train batching.",
  iterate: "Fast iteration on a local-first repo: the per-merge gate runs the test-impact SELECTION (a ranked guess, narrower than scoped), and the full suite runs nightly on the base branch instead. A defect the selection misses lands on the base and is caught within a day — cheap when a rebase is the whole cost, wrong when there is a real deployment (use Strict there).",
  fast: "Skips per-ticket review in favor of one review per train; gate runs once per train instead of per ticket. Red base allowed only if it is already-known debt.",
  sprint: "Skips pre-merge review entirely (a review ticket is filed after the fact); gate runs guards-only per train, full suite on schedule. Red base allowed and tracked as debt.",
};

/**
 * Resolve a project's risk posture from a raw preference value. Any value other
 * than an exact member of {@link RISK_POSTURES} resolves to `"standard"` —
 * unset, unrecognized, or mistyped all fail closed to today's behaviour rather
 * than silently adopting a faster (weaker) posture.
 */
export function resolveRiskPosture(value: string | null | undefined): RiskPosture {
  return (RISK_POSTURES as readonly string[]).includes(value ?? "")
    ? (value as RiskPosture)
    : RISK_POSTURE_DEFAULT;
}

export function readRiskPosture(prefMap: ReadonlyMap<string, string>, projectId: string): RiskPosture {
  return resolveRiskPosture(prefMap.get(riskPosturePref.key(projectId)));
}
