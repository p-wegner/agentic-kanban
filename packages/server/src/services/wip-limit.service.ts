import { readStrategyBullseye, resolveMonitorTunables } from "@agentic-kanban/shared/lib/strategy-objective-file";

/**
 * THE WIP resolver (#919, collapsed by #1102).
 *
 * "How many agents may this project run at once?" used to have three stored answers: the
 * per-project `wip_limit_<projectId>` (what the onboarding wizard wrote), the Strategy Bullseye's
 * `activeAgentsTarget`, and the legacy global `nudge_wip_limit`. #919 made every surface read ONE
 * precedence over them; #1102 removed the choice itself. The Bullseye is the only place a project's
 * WIP is configured: `wip_limit_<id>` was migrated into it at startup and then deleted
 * (`wip-limit-migration.service.ts`), and neither key is writable any more.
 *
 * What remains is override -> Bullseye -> default. "Default" is `resolveMonitorTunables`' own
 * no-Bullseye path, which still honours a STORED `nudge_wip_limit` row — the migration leaves that
 * path alone on purpose (the ticket's "otherwise leave the default path"), so a board that ran at a
 * legacy global number keeps running at it until someone sets a Bullseye target. It is reported as
 * `default`, not as a configured value: nobody can configure it any more.
 *
 * A **prefMap resolver** (see `packages/server/CLAUDE.md`): pure, synchronous, first parameter
 * `prefMap`. `configured` is `null` when the Bullseye names no target — the distinction
 * drive-preflight needs so it does not warn about a number nobody chose — while `limit` is the
 * number every other surface acts on.
 */

/** Where the effective WIP limit came from — reported so a surface can say WHY it holds. */
export type WipLimitSource =
  /** An explicit caller override (e.g. the dependency-wave API's `wipLimit` query param). */
  | "override"
  /** The Strategy Bullseye's `activeAgentsTarget`. */
  | "strategy"
  /** No Bullseye target — `resolveMonitorTunables`' own default path. */
  | "default";

export interface ResolvedWipLimit {
  /** The number to act on. Always >= 1. */
  limit: number;
  /**
   * The CONFIGURED limit, or `null` when this project's Bullseye names no WIP target.
   * `limit` substitutes the default in that case; this field does not.
   */
  configured: number | null;
  source: WipLimitSource;
}

/**
 * Resolve a project's WIP limit: an explicit `override`, else the Bullseye's
 * `activeAgentsTarget`, else `resolveMonitorTunables`' default — called rather than
 * re-implemented, so the Bullseye's clamping and the legacy fallback stay in one place.
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

  const { tunables, source } = resolveMonitorTunables(prefMap, projectId);
  const limit = tunables.activeAgentsTarget > 0 ? tunables.activeAgentsTarget : 1;

  // `resolveMonitorTunables` reports `strategy` only when a Bullseye actually parsed, and a
  // Bullseye can exist for its segments/provider policy alone — its substituted default is not
  // a configured target, so the raw field decides.
  if (source === "strategy") {
    const raw = readStrategyBullseye(prefMap, projectId)?.activeAgentsTarget;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return { limit, configured: limit, source: "strategy" };
    }
  }
  return { limit, configured: null, source: "default" };
}
