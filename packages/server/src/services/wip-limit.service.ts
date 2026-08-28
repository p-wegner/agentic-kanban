import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { readStrategyBullseye, resolveMonitorTunables } from "@agentic-kanban/shared/lib/strategy-objective-file";

/**
 * THE WIP resolver (#919).
 *
 * Three surfaces answered "how many agents may this project run at once?" independently, and
 * disagreed:
 *
 *  1. `wip_limit_<projectId>` — the per-project pref the onboarding wizard writes, read only by
 *     `dependency-wave.service.ts`.
 *  2. the Strategy Bullseye's `activeAgentsTarget` via `resolveMonitorTunables` — read by the
 *     monitor's two auto-start loops, the backlog refill, the dependency auto-chain, the plugin
 *     loop starter and the sprint-capacity planner, all of which were blind to (1).
 *  3. `drive-preflight.service.ts`, which read the Bullseye RAW and fell back to the legacy
 *     global `nudge_wip_limit` — deliberately bypassing `resolveMonitorTunables` because it needs
 *     to distinguish "no WIP target configured" from "the default is 5".
 *
 * So a project configured with `wip_limit_<id>=2` had the Dependency Waves panel offering to
 * start 5 while the monitor ran 2 — the #654 defect, fixed for ONE of the three surfaces.
 *
 * This module is the single answer. It is a **prefMap resolver** (see `packages/server/CLAUDE.md`):
 * pure, synchronous, first parameter `prefMap`, so every caller can share one decision without
 * any of them growing a DB read of its own.
 *
 * It deliberately does NOT collapse surface (3)'s distinction — it EXPRESSES it. `configured` is
 * `null` when nothing was configured, which is exactly the signal drive-preflight needs, while
 * `limit` is the number the other two surfaces act on. One function, both questions, no second
 * derivation.
 */

const wipLimitPref = projectPref("wip_limit");

export function wipLimitPrefKey(projectId: string): string {
  return wipLimitPref.key(projectId);
}

/** Where the effective WIP limit came from — reported so a surface can say WHY it holds. */
export type WipLimitSource =
  /** An explicit caller override (e.g. the dependency-wave API's `wipLimit` query param). */
  | "override"
  /** The per-project `wip_limit_<projectId>` pref. */
  | "wip_limit_pref"
  /** The Strategy Bullseye's `activeAgentsTarget`. */
  | "strategy"
  /** The legacy global `nudge_wip_limit` pref. */
  | "legacy_pref"
  /** Nothing was configured anywhere — `resolveMonitorTunables`' own default. */
  | "default";

export interface ResolvedWipLimit {
  /** The number to act on. Always ≥ 1. */
  limit: number;
  /**
   * The CONFIGURED limit, or `null` when this project has no WIP target set anywhere.
   * `limit` substitutes the default in that case; this field does not — which is what lets
   * drive-preflight stay silent instead of reporting a default it invented.
   */
  configured: number | null;
  source: WipLimitSource;
}

function positiveInt(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve a project's WIP limit. Precedence, most specific first:
 *
 *  1. `override` — an explicit caller-supplied number (the dependency-wave API's query param).
 *  2. `wip_limit_<projectId>` — the per-project pref the onboarding wizard writes.
 *  3. the Strategy Bullseye's `activeAgentsTarget`.
 *  4. the legacy global `nudge_wip_limit`.
 *  5. `resolveMonitorTunables`' own default.
 *
 * Steps 3–5 are `resolveMonitorTunables`' own precedence, called rather than re-implemented, so
 * the Bullseye stays the single source of truth for everything below the per-project pref.
 */
export function resolveWipLimit(
  prefMap: Map<string, string>,
  projectId: string,
  opts: { override?: number } = {},
): ResolvedWipLimit {
  const override = opts.override !== undefined && Number.isFinite(opts.override) && opts.override > 0
    ? Math.floor(opts.override)
    : null;
  if (override !== null) return { limit: override, configured: override, source: "override" };

  const perProject = positiveInt(prefMap.get(wipLimitPrefKey(projectId)));
  if (perProject !== null) return { limit: perProject, configured: perProject, source: "wip_limit_pref" };

  const { tunables, source } = resolveMonitorTunables(prefMap, projectId);
  const limit = tunables.activeAgentsTarget > 0 ? tunables.activeAgentsTarget : 1;

  // `resolveMonitorTunables` reports `strategy` only when a Bullseye actually parsed, so this is
  // the honest "was anything configured?" test — it is NOT re-derived from the raw pref.
  if (source === "strategy") {
    // A Bullseye can exist without naming a target (segments only), in which case
    // `activeAgentsTarget` is the substituted default, not a configured value.
    const raw = readStrategyBullseye(prefMap, projectId)?.activeAgentsTarget;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return { limit, configured: limit, source: "strategy" };
    }
  }

  const legacy = positiveInt(prefMap.get("nudge_wip_limit"));
  if (legacy !== null) return { limit, configured: legacy, source: "legacy_pref" };

  return { limit, configured: null, source: "default" };
}
