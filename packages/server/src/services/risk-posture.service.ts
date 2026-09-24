import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";
import type { BaseSweepInfo, RedBasePolicy, RiskPosture, RiskPostureLevel } from "@agentic-kanban/shared/types";
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
 *  - `iterate`  — active local-first development (#983). Per-merge gate is the test-impact
 *                 SELECTION rather than the full suite; the full suite runs on a daily sweep of
 *                 the base branch instead, and every miss it finds is recorded to the outcome
 *                 ledger. Trades "a defect is caught before it lands" for "a defect is caught
 *                 within a day and costs a rebase" — right for a repo with no deployment,
 *                 wrong for one with a real release (use `strict`). Since #1233 a red sweep
 *                 FILES a heal ticket instead of holding the train window (`redBasePolicy`
 *                 `allow-file-debt-ticket`): master only moves through trains, so a red
 *                 nightly under `block` froze the project until a human hand-landed a fix.
 *  - `fast`     — large backlog, trusted agents. Scoped gate once per train, review the train
 *                 not each ticket, red base allowed if the red set is known debt, contention
 *                 downgraded to a warning, placement prefers remote.
 *  - `sprint`   — greenfield/prototype. Guards-only gate, no per-ticket review, red base allowed
 *                 with a debt ticket, builder self-tests off, contention off.
 *  - `flow`     — the fastest honest cycle (#1240, decision 019 part 3), below `iterate` on the
 *                 ladder (`docs/integration-risk-ladder.md`). Per-merge gate = typecheck + the
 *                 test-impact selection + the diff's own tests, with NO guard floor at merge
 *                 (`guards-at-merge.ts` yields `intersecting`); red base is `report` — never a
 *                 hold, never a ticket; and the ONLY full-suite run is the release candidate's
 *                 sweep, so `sweepIntervalMs` is `null` by design. Everything else as `iterate`.
 *
 * Visibility rule: a weaker posture may only weaken verification VISIBLY — `summary` names what
 * this posture skips relative to `standard`, and every gate/merge message that reads a
 * `RiskPosture` must include it.
 */
export type { RedBasePolicy, RiskPosture, RiskPostureLevel };

// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const riskPosturePrefDef = projectPref("risk_posture");

export function riskPosturePrefKey(projectId: string): string {
  return riskPosturePrefDef.key(projectId);
}

// #1015: the per-project red-base-policy override. Registered in the dynamic preference-key
// registry alongside `risk_posture`, so an unregistered prefix is a COMPILE error here too.
const redBasePolicyPrefDef = projectPref("red_base_policy");

export function redBasePolicyPrefKey(projectId: string): string {
  return redBasePolicyPrefDef.key(projectId);
}

/**
 * Softness order of {@link RedBasePolicy} — the ONE place the "softer only" direction is
 * defined, so the override check and the red-debt cap's degrade step cannot disagree about
 * which way is looser. `report` (#1233) is the softest: a red base never holds the train window
 * and files no ticket — the `flow` posture (#1240) is the one shipped level that resolves it;
 * every other level reaches it only as a softer-only project override.
 */
export const RED_BASE_POLICY_RANK: Record<RedBasePolicy, number> = {
  block: 0,
  "allow-known-debt": 1,
  "allow-file-debt-ticket": 2,
  report: 3,
};

const VALID_RED_BASE_POLICIES: ReadonlySet<string> = new Set(Object.keys(RED_BASE_POLICY_RANK));

/**
 * Apply the per-project `red_base_policy_<projectId>` override to a level-derived posture
 * (#1015, decision 017 Amendment 2026-09-04).
 *
 * **Softer only.** `block` -> `allow-known-debt` -> `allow-file-debt-ticket` -> `report` is allowed; the
 * reverse is IGNORED with a logged warning rather than honoured. The reason is decision 017's
 * own shape: the LEVEL is the dial that says how strict a project is, and a per-field key that
 * could tighten one dimension would re-create exactly the "~8 prefs to align by hand, and
 * nothing says what a partial write left behind" problem the posture replaced. Loosening is
 * different in kind — it is what a dev board needs to land-then-heal (proposal
 * `2026-09-03-dev-board-vs-deployed-board.md` §3.B) without abandoning its level's gate tier,
 * review mode and train sizing.
 *
 * Visibility rule (decision 017): an applied override is folded into `summary`, so any message
 * built with `formatPostureNote` names it. An unparseable value fails CLOSED — the level's own
 * policy stands.
 */
export function applyRedBasePolicyOverride(
  posture: RiskPosture,
  raw: string | null | undefined,
  projectId: string,
): RiskPosture {
  if (raw == null || raw === "") return posture;
  if (!VALID_RED_BASE_POLICIES.has(raw)) {
    console.warn(
      `[risk-posture] ignoring unrecognized red-base-policy override '${raw}' for project ${projectId} — `
        + `posture '${posture.level}' keeps redBasePolicy '${posture.redBasePolicy}' (#1015)`,
    );
    return posture;
  }
  const requested = raw as RedBasePolicy;
  if (requested === posture.redBasePolicy) return posture;
  if (RED_BASE_POLICY_RANK[requested] < RED_BASE_POLICY_RANK[posture.redBasePolicy]) {
    console.warn(
      `[risk-posture] ignoring STRICTER red-base-policy override '${requested}' for project ${projectId} — `
        + `the override is softer-only and posture '${posture.level}' already resolves `
        + `'${posture.redBasePolicy}'; raise strictness with the posture LEVEL instead (#1015)`,
    );
    return posture;
  }
  return {
    ...posture,
    redBasePolicy: requested,
    summary: `${posture.summary} (red base: '${requested}' per project override)`,
  };
}

const VALID_LEVELS: ReadonlySet<string> = new Set<RiskPostureLevel>(RISK_POSTURES);

/** Per-ticket override prefix — an issue tag `risk:<level>` wins for its
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

  // The per-project red-base-policy override is applied AFTER level derivation, and only ever
  // in the softer direction — see `applyRedBasePolicyOverride`.
  return applyRedBasePolicyOverride(
    postureForLevel(level, source),
    prefMap.get(redBasePolicyPrefKey(projectId)),
    projectId,
  );
}

/** The pure level -> posture table. Everything a LEVEL implies lives here; per-field project
 *  overrides are applied by the caller, so this table stays the definition of the level. */
function postureForLevel(level: RiskPostureLevel, source: RiskPosture["source"]): RiskPosture {
  switch (level) {
    case "strict":
      return {
        level, source,
        gateTier: "full",
        // A strict project gates every merge in full, so a sweep only adds value for changes
        // that arrive OUTSIDE a merge (a direct push to the base). Half-daily is enough for that.
        sweepIntervalMs: 12 * 60 * 60 * 1000,
        reviewMode: "thorough",
        redBasePolicy: "block",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        // #919: strict lands one at a time on purpose — every merge carries a full gate.
        mergesPerCycle: 1,
        relaunchesPerCycle: 1,
        builderStopChecks: "tests-and-typecheck",
        contentionMode: "serialize",
        placementBias: "host-half",
        summary: "strict: full gate + thorough review per ticket, no train, red base blocks all merges",
      };
    case "fast":
      return {
        level, source,
        gateTier: "scoped",
        sweepIntervalMs: 6 * 60 * 60 * 1000,
        reviewMode: "train-only",
        redBasePolicy: "allow-known-debt",
        trainMaxSize: 8,
        trainMaxWaitMs: 20 * 60 * 1000,
        mergesPerCycle: 4,
        relaunchesPerCycle: 4,
        builderStopChecks: "typecheck-only",
        contentionMode: "warn",
        placementBias: "remote-preferred",
        summary: "fast: skips per-ticket review (reviews the train instead), gate once per train, red base allowed if it is known debt, builder tests skipped (typecheck only)",
      };
    case "sprint":
      return {
        level, source,
        gateTier: "scoped-base-watch",
        // Makes this level's long-standing description ("full suite on schedule") actually true.
        sweepIntervalMs: 24 * 60 * 60 * 1000,
        reviewMode: "none",
        redBasePolicy: "allow-file-debt-ticket",
        trainMaxSize: 12,
        trainMaxWaitMs: 30 * 60 * 1000,
        // #919 acceptance: a sprint project lands a whole ready batch in ONE cycle rather
        // than dribbling two per cycle behind a train it already gated as a unit.
        mergesPerCycle: 8,
        relaunchesPerCycle: 6,
        builderStopChecks: "none",
        contentionMode: "off",
        placementBias: "remote-preferred",
        summary: "sprint: no per-ticket review, guards-only gate, red base allowed (files a debt ticket), builder self-tests off, contention off",
      };
    case "iterate":
      return {
        level, source,
        // The per-merge gate is the test-impact SELECTION — narrower than `scoped`, and a ranked
        // GUESS rather than a provable non-dependency. That is only honest because the nightly
        // sweep below runs the full suite on the base and feeds every miss back into the ledger
        // (#982), which is what turns the guess into a measured one.
        gateTier: "impact",
        sweepIntervalMs: 24 * 60 * 60 * 1000,
        reviewMode: "standard",
        // #1233 (decision 017 Amendment 2026-09-24): a red nightly sweep FILES a heal ticket and
        // lets the train window depart. Under `block` the same sweep held every train — and the
        // base only moves through trains, so the project froze until a human hand-landed a fix
        // (measured 2026-09-24 on the dev board). The per-merge gate here is the impact
        // selection, which never proved the base green in the first place; holding on the
        // sweep's verdict bought nothing the heal ticket does not disclose better.
        redBasePolicy: "allow-file-debt-ticket",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        mergesPerCycle: 2,
        relaunchesPerCycle: 2,
        builderStopChecks: "tests-capacity-gated",
        contentionMode: "serialize",
        placementBias: "host-preferred",
        summary: "iterate: per-merge gate is the test-impact selection (a ranked guess, narrower than scoped); the FULL suite runs nightly on the base instead, its misses are recorded, and a red base files a heal ticket rather than holding the train window",
      };
    case "flow":
      return {
        level, source,
        // The same ranked GUESS `iterate` runs — and, unlike `iterate`, with nothing behind it on
        // THIS branch: no nightly master sweep, no guard floor at merge (`guardsAtMergeForPosture`
        // reads this level). What backs it is the release candidate's full sweep (decision 019),
        // which is the only place a full verdict is owed under this level.
        gateTier: "impact",
        // `null` = no scheduled base sweep at all, by design — not the opt-in rule's "no posture
        // chosen". `describeBaseSweep` says "release candidate only" for this case.
        sweepIntervalMs: null,
        reviewMode: "standard",
        // `report` (rank 3, the softest): a red master never holds the train window and files no
        // heal ticket. The delivery view and the sweep row are where the red is disclosed; the
        // rc sweep is where it is healed (#1239).
        redBasePolicy: "report",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        mergesPerCycle: 2,
        relaunchesPerCycle: 2,
        builderStopChecks: "tests-capacity-gated",
        contentionMode: "serialize",
        placementBias: "host-preferred",
        summary: "flow: merge gate = typecheck + impact selection + the diff's own tests; no guard floor at merge; red base reported, never blocking; the full suite runs on the release candidate only",
      };
    case "standard":
    default:
      // Today's behaviour, exactly — see the header doc. The ONE deliberate exception is the
      // sweep cadence below (#1031, decision 017 Amendment 2026-09-04 #1031).
      return {
        level: "standard", source,
        gateTier: "full",
        // Half-daily, the same as `strict` and for the same reason: a `full` per-merge gate
        // already verifies every landing, so a sweep only adds value for changes that reach
        // the base OUTSIDE a merge (a direct push). Until #1031 this was the pre-posture
        // `BASE_HEALTH_DEFAULT_INTERVAL_MS` (30 min) — which meant an explicitly-standard
        // project ran the FULL suite 48x a day on the shared box while every other posture
        // swept 2-4x, and the cadence proposal's own "standard | full | 30 min" row was the
        // only half-hour full-suite sweep left. `BASE_HEALTH_DEFAULT_INTERVAL_MS` is now only
        // the sweep loop's tick rate. (An UNSET project still gets none — see the opt-in rule
        // in `resolveBaseSweepIntervalMs`, which is what stops idle imported repos burning
        // compute.)
        sweepIntervalMs: 12 * 60 * 60 * 1000,
        reviewMode: "standard",
        redBasePolicy: "block",
        trainMaxSize: 1,
        trainMaxWaitMs: 0,
        // #919: today's board-wide constants, so `standard` still reproduces current behaviour.
        mergesPerCycle: 2,
        relaunchesPerCycle: 2,
        builderStopChecks: "tests-capacity-gated",
        contentionMode: "serialize",
        placementBias: "host-preferred",
        summary: "standard: today's default behaviour, nothing skipped",
      };
  }
}

/**
 * How often the periodic base-branch health sweep should run for this project — the OPT-IN
 * resolver (#983). This is what callers read; `posture.sweepIntervalMs` alone is only the
 * NOMINAL cadence of the level.
 *
 * **`null` means no scheduled sweep at all**, and that is what an un-chosen posture returns.
 * Before this, `base-branch-health-reconciler` ran a full `check:arch && typecheck && test:mine`
 * for EVERY registered project every 30 minutes — ~25 projects, serially, most of them imported
 * fixtures nobody is developing. That load competes with the developer's own suite and is the
 * documented suspect behind `Worker exited unexpectedly` crashes and 5s guard-suite timeouts.
 *
 * Choosing a posture IS the opt-in — no second knob. `source` already distinguishes an explicit
 * `risk_posture_<projectId>` pref from the fallback, so a project nobody has configured spends
 * no background compute, and a `risk:` ISSUE TAG does not opt a project in either: a tag is
 * scoped to one ticket's workspace and cannot speak for a project-wide periodic sweep.
 */
export function resolveBaseSweepIntervalMs(posture: RiskPosture): number | null {
  if (posture.source !== "risk_posture") return null;
  return posture.sweepIntervalMs;
}

/**
 * The EFFECTIVE base sweep for a project as one wire-ready struct (#1031) — what
 * `GET /api/projects/:id/base-branch-health` and `GET /api/projects/health` report, so an
 * operator can see which projects sweep, how often, and why, without reading the posture
 * table. Built on `resolveBaseSweepIntervalMs` (never `posture.sweepIntervalMs`), so it can
 * never claim a sweep for a project the opt-in rule excludes; `nominalIntervalMs` carries the
 * level's cadence separately so "not scheduled" and "would sweep every 12 h once a posture is
 * chosen" are both readable from the same response.
 *
 * `nextDueAt` is the plain arithmetic `lastProbeAt + intervalMs` — a hint for a human, not the
 * scheduler's verdict (`resolveBaseHealthProbeDue` also honours the post-timeout back-off and
 * the in-flight guard). Pure: it takes the last probe time as an argument.
 */
export function describeBaseSweep(
  posture: RiskPosture,
  lastProbeAt: string | null | undefined = null,
): BaseSweepInfo {
  const intervalMs = resolveBaseSweepIntervalMs(posture);
  let nextDueAt: string | null = null;
  if (intervalMs !== null && lastProbeAt) {
    const lastMs = Date.parse(lastProbeAt);
    if (Number.isFinite(lastMs)) nextDueAt = new Date(lastMs + intervalMs).toISOString();
  }
  return {
    scheduled: intervalMs !== null,
    intervalMs,
    nominalIntervalMs: posture.sweepIntervalMs,
    postureLevel: posture.level,
    postureSource: posture.source,
    reason: intervalMs === null
      ? (posture.source === "issue_tag"
        ? "a risk: issue tag is scoped to one ticket and does not opt the project into a sweep"
        : posture.sweepIntervalMs === null
          // #1240: a level with NO nominal cadence chose that on purpose — `flow` owes a full
          // verdict on the release candidate only, so this is not the opt-in rule's "unchosen".
          ? `risk posture '${posture.level}' schedules no base sweep by design — full suite: release candidate only`
          : "no risk posture chosen for this project — choosing one is the opt-in (#983)")
      : `risk posture '${posture.level}' sweeps the base every ${formatIntervalHuman(intervalMs)}`,
    nextDueAt,
  };
}

/** `30 min`, `6 h`, `12 h`, `24 h` — for the `reason` text and the UI. */
export function formatIntervalHuman(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)} h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)} min`;
  return `${Math.round(ms / 1000)} s`;
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
