import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { RISK_POSTURE_VALUES } from "@agentic-kanban/shared/lib/risk-posture-values";
import type { RiskPosture, RiskPostureLevel } from "@agentic-kanban/shared/types";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getIssueTagRows } from "../repositories/tag.repository.js";

/**
 * Risk posture (#911, decision 017) — the ONE dial replacing the ~8 prefs an operator had to
 * align by hand to change how fast a project moves (verify_gate_strategy, auto_review,
 * review_auto_fix, quiesce_builders_during_gate, file_contention, verify_max_workers, Bullseye
 * WIP, merge strategy). Mirrors `resolveStartPolicy` (decision 008): consumers read the
 * resolved struct, never the raw `risk_posture_<projectId>` pref — enforced by
 * `risk-posture-raw-read-ratchet.test.ts`.
 *
 *  - `strict`   — release branches, client repos with allowlists. Full per-ticket gate + review,
 *                 no train, red base always blocks, builder self-tests run in full.
 *  - `standard` — normal feature work. **Defined to reproduce today's behaviour exactly** —
 *                 every field below is today's actual default, not the proposal's target state
 *                 (e.g. `trainMaxSize: 1`, not the proposal's "≤4", since #905 owns raising that
 *                 default; `gateTier: "full"`, matching `DEFAULT_VERIFY_GATE_STRATEGY`).
 *  - `fast`     — large backlog, trusted agents. Scoped gate once per train, review the train
 *                 not each ticket, red base allowed if the red set is known debt, contention
 *                 downgraded to a warning, placement prefers remote.
 *  - `sprint`   — greenfield/prototype. Guards-only gate, no per-ticket review, red base allowed
 *                 with a debt ticket, builder self-tests off, contention off.
 *
 * Visibility rule: a weaker posture may only weaken verification VISIBLY — `summary` names what
 * this posture skips relative to `standard`, and every gate/merge message that reads a
 * `RiskPosture` must include it.
 */
export type { RiskPosture, RiskPostureLevel };

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const riskPosturePrefDef = projectPref("risk_posture");

export function riskPosturePrefKey(projectId: string): string {
  return riskPosturePrefDef.key(projectId);
}

const VALID_LEVELS: ReadonlySet<string> = new Set<RiskPostureLevel>(RISK_POSTURE_VALUES);

/** Per-ticket override prefix — an issue tag `risk:strict|standard|fast|sprint` wins for its
 *  workspace over the project's `risk_posture_<projectId>` pref. */
export const RISK_TAG_PREFIX = "risk:";

function levelFromRiskTag(tagName: string): RiskPostureLevel | null {
  if (!tagName.startsWith(RISK_TAG_PREFIX)) return null;
  const candidate = tagName.slice(RISK_TAG_PREFIX.length);
  return VALID_LEVELS.has(candidate) ? (candidate as RiskPostureLevel) : null;
}

/**
 * Resolve the effective risk posture for a project, given an optional per-ticket tag override
 * that has already been read (pure — see `resolveIssueRiskPosture` for the DB-reading variant
 * that finds the override itself).
 */
export function resolveRiskPosture(
  prefMap: Map<string, string>,
  projectId: string,
  opts: { tagOverride?: string | null } = {},
): RiskPosture {
  const overrideLevel = opts.tagOverride ? levelFromRiskTag(opts.tagOverride) : null;
  const explicit = prefMap.get(riskPosturePrefKey(projectId));

  const level: RiskPostureLevel = overrideLevel
    ?? (VALID_LEVELS.has(explicit ?? "") ? (explicit as RiskPostureLevel) : "standard");
  const source: RiskPosture["source"] = overrideLevel
    ? "issue_tag"
    : VALID_LEVELS.has(explicit ?? "")
      ? "risk_posture"
      : "default";

  switch (level) {
    case "strict":
      return {
        level, source,
        gateTier: "full",
        reviewMode: "thorough",
        redBasePolicy: "block",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        builderStopChecks: "tests-and-typecheck",
        contentionMode: "serialize",
        placementBias: "host-half",
        summary: "strict: full gate + thorough review per ticket, no train, red base blocks all merges",
      };
    case "fast":
      return {
        level, source,
        gateTier: "scoped",
        reviewMode: "train-only",
        redBasePolicy: "allow-known-debt",
        trainMaxSize: 8,
        trainMaxWaitMs: 20 * 60 * 1000,
        builderStopChecks: "typecheck-only",
        contentionMode: "warn",
        placementBias: "remote-preferred",
        summary: "fast: skips per-ticket review (reviews the train instead), gate once per train, red base allowed if it is known debt, builder tests skipped (typecheck only)",
      };
    case "sprint":
      return {
        level, source,
        gateTier: "scoped-base-watch",
        reviewMode: "none",
        redBasePolicy: "allow-file-debt-ticket",
        trainMaxSize: 12,
        trainMaxWaitMs: 30 * 60 * 1000,
        builderStopChecks: "none",
        contentionMode: "off",
        placementBias: "remote-preferred",
        summary: "sprint: no per-ticket review, guards-only gate, red base allowed (files a debt ticket), builder self-tests off, contention off",
      };
    case "standard":
    default:
      // Today's behaviour, exactly — see the header doc.
      return {
        level: "standard", source,
        gateTier: "full",
        reviewMode: "standard",
        redBasePolicy: "block",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        builderStopChecks: "tests-capacity-gated",
        contentionMode: "serialize",
        placementBias: "host-preferred",
        summary: "standard: today's default behaviour, nothing skipped",
      };
  }
}

/**
 * Find the `risk:<level>` tag on an issue, if any — the per-ticket override that wins for that
 * issue's workspace regardless of the project's `risk_posture_<projectId>` pref. A prefix scan
 * (not an exact-name lookup like `hasSkipAutoStartTag`) because the tag NAME carries the level.
 * Reads through `getIssueTagRows` (`repositories/tag.repository.ts`) rather than drizzle
 * directly — a service reaching for drizzle itself is the `services-bypass-repositories`
 * violation `pnpm lint:arch` enforces.
 */
export async function getIssueRiskTag(issueId: string, database: Database = db): Promise<string | null> {
  const rows = await getIssueTagRows(issueId, database);
  return rows.find((r) => r.name.startsWith(RISK_TAG_PREFIX))?.name ?? null;
}

/**
 * DB-reading convenience wrapper: resolve a project's risk posture with the issue's own
 * `risk:<level>` tag override applied, if it carries one.
 */
export async function resolveIssueRiskPosture(
  issueId: string,
  projectId: string,
  prefMap: Map<string, string>,
  database: Database = db,
): Promise<RiskPosture> {
  const tagOverride = await getIssueRiskTag(issueId, database);
  return resolveRiskPosture(prefMap, projectId, { tagOverride });
}
