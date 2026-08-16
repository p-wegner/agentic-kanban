// --- Priority vocabulary (#516) ----------------------------------------------------
//
// The canonical set is low | medium | high | critical. A SECOND vocabulary using
// "urgent" in place of "critical" leaked in through the AI paths: the decompose prompt
// asks the model for "urgent" (issue-ai.service.ts), its validator accepts it, and the
// created child keeps it — while `voice-capture.service.ts` translates urgent -> critical
// and is the only place that does.
//
// The consequence is user-visible and asymmetric: an "urgent" issue sorts at rank 0
// (tableView-sorting's PRIORITY_ORDER lists it) but has no colour in `priorityColors`
// and no lane in `PRIORITY_LANE_STYLES`, so it renders unstyled and lands in
// "ungrouped". Several client maps grew an `urgent` key as a patch for exactly this.
//
// One vocabulary, one alias, one place to translate.

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** Legacy/AI spellings accepted on input and folded into the canonical set. */
const PRIORITY_ALIASES: Record<string, IssuePriority> = {
  urgent: "critical",
  crit: "critical",
  normal: "medium",
};

/**
 * Fold any inbound priority string into the canonical set.
 * Unknown values become `fallback` ("medium") rather than being stored verbatim —
 * storing an unrecognised priority is what produced the unstyled-but-top-sorted issues.
 */
export function normalizeIssuePriority(
  raw: string | null | undefined,
  fallback: IssuePriority = "medium",
): IssuePriority {
  const key = raw?.trim().toLowerCase() ?? "";
  if ((ISSUE_PRIORITIES as readonly string[]).includes(key)) return key as IssuePriority;
  return PRIORITY_ALIASES[key] ?? fallback;
}
