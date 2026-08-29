import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
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

const VALID_LEVELS: ReadonlySet<string> = new Set<RiskPostureLevel>(RISK_POSTURES);

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
 * Does this posture's `placementBias` forbid remote dispatch (#937)?
 *
 * Only `host-half` does. It is `strict`'s value, and `strict` is the posture for release
 * branches and client repos — the same population `allowed_profiles_<projectId>` protects, and
 * for the same reason: a fleet worker authenticates the agent with its OWN local login and the
 * board deliberately sends no credentials (decision 012), so the board can PREFER a machine but
 * cannot make a worker honour a rigor requirement. A project whose operator set `strict`
 * because the work must not leave the box is exactly the project that must not be dispatched to
 * one that cannot prove it qualifies.
 *
 * `host-preferred` (standard) and `remote-preferred` (fast/sprint) are PREFERENCES, not
 * constraints, and this resolver deliberately reports neither as blocking — a preference that
 * silently became a refusal would be the "weakens invisibly" failure decision 017 forbids, and
 * the board has no worker-side attestation to bias toward or away from a machine with. So
 * `standard` reproduces today's behaviour exactly (no new host fallback), and `fast`/`sprint`
 * change nothing here until such an attestation exists.
 */
export function remoteDispatchBlockedByPlacementBias(
  posture: RiskPosture,
): { blocked: false } | { blocked: true; reason: string } {
  if (posture.placementBias !== "host-half") return { blocked: false };
  return {
    blocked: true,
    reason:
      `risk posture '${posture.level}' sets placementBias 'host-half' (source: ${posture.source}), so this ` +
      `project does not dispatch to a fleet worker — a worker authenticates with its OWN local login and the ` +
      `board cannot make it honour the posture (decision 012/017)`,
  };
}

/**
 * Decision 017's VISIBILITY rule, as one formatter (#937).
 *
 * "Every gate/merge message that reads a `RiskPosture` field must fold `.summary` into its
 * output" is a rule about message TEXT, so it needs one implementation — otherwise each
 * message site invents its own wording and a reader cannot tell whether the absence of a
 * posture note means `standard` or means the site forgot.
 *
 * Returns the empty string for a missing posture, so a caller that never resolved one cannot
 * accidentally claim one decided something.
 */
export function formatPostureNote(posture: RiskPosture | undefined | null): string {
  if (!posture) return "";
  return ` [risk posture: ${posture.summary} (source: ${posture.source})]`;
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
