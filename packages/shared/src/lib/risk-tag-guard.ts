import { RISK_POSTURES, RISK_POSTURE_DEFAULT, riskPosturePref, type RiskPosture } from "./risk-posture.js";

/** Per-ticket override prefix — an issue tag `risk:<level>` (#1745). */
export const RISK_TAG_NAME_PREFIX = "risk:";

/** Header an OPERATOR surface (the UI, a CLI invoked with its explicit flag) sends to be allowed any level. */
export const OPERATOR_ACTOR_HEADER = "x-kanban-actor";
export const OPERATOR_ACTOR_VALUE = "operator";

/**
 * Strictness ladder, strictest first. Index = softness: a higher index verifies less.
 * (`flow` sits below `iterate` per docs/integration-risk-ladder.md.)
 */
const SOFTNESS_ORDER: readonly RiskPosture[] = ["strict", "standard", "iterate", "flow", "fast", "sprint"];

export function riskPostureSoftness(level: RiskPosture): number {
  return SOFTNESS_ORDER.indexOf(level);
}

/** The level a `risk:<level>` tag names, or null when it is not a risk tag / names no known level. */
export function riskTagLevel(tagName: string): RiskPosture | null {
  const trimmed = tagName.trim();
  if (!trimmed.toLowerCase().startsWith(RISK_TAG_NAME_PREFIX)) return null;
  const candidate = trimmed.slice(RISK_TAG_NAME_PREFIX.length);
  return (RISK_POSTURES as readonly string[]).includes(candidate) ? (candidate as RiskPosture) : null;
}

export function projectPostureLevel(raw: string | null | undefined): RiskPosture {
  return (RISK_POSTURES as readonly string[]).includes(raw ?? "") ? (raw as RiskPosture) : RISK_POSTURE_DEFAULT;
}

export function riskPosturePrefKeyFor(projectId: string): string {
  return riskPosturePref.key(projectId);
}

/**
 * Why an AGENT-facing write may not apply these tags, or null when all are allowed.
 * Softer than the project posture is refused; equal or stricter is fine. Only `risk:` tags are judged.
 */
export function refuseSofterRiskTags(tagNames: readonly string[], projectPrefValue: string | null | undefined): string | null {
  const projectLevel = projectPostureLevel(projectPrefValue);
  for (const name of tagNames) {
    const level = riskTagLevel(name);
    if (!level) continue;
    if (riskPostureSoftness(level) > riskPostureSoftness(projectLevel)) {
      return `Refused: tag '${RISK_TAG_NAME_PREFIX}${level}' is softer than this project's risk posture '${projectLevel}'. `
        + `An agent may only tighten a ticket's posture; an operator sets a softer one from the UI or the CLI.`;
    }
  }
  return null;
}

/** The audit comment body for an applied `risk:` tag (#1745). */
export function describeRiskTagApplied(level: RiskPosture, source: string): string {
  return `risk:${level} tag applied by ${source} — this ticket's posture is now '${level}' for its exit checks (implement-exit, review-exit gate).`;
}
