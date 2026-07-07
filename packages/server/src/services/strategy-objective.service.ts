import { preferences } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { getProfilePrefKey } from "./agent-provider.js";
import { fetchLiveQuotaUsage } from "./quota-usage.service.js";
import type { QuotaUsageResult } from "./quota-usage.service.js";
import { resolveEffectiveModel } from "./effective-config.service.js";
import { selectPolicyByPriority } from "@agentic-kanban/shared/lib/strategy-policy";
import type { ProviderPolicyMode, ProviderProfilePolicy } from "@agentic-kanban/shared/lib/strategy-policy";
import {
  parseStrategyBullseyeConfig,
} from "@agentic-kanban/shared/lib/strategy-objective-file";
import type { StrategyBullseyeConfig } from "@agentic-kanban/shared/lib/strategy-objective-file";

// Policy shape + priority-order selection live in the shared package so the
// client's Strategy Targets round-trip codec and this service can never diverge
// again (the client copy silently dropped `model` on save — #983). Docs for the
// modes / headroomPct semantics live on the shared definitions.
export type { ProviderPolicyMode, ProviderProfilePolicy } from "@agentic-kanban/shared/lib/strategy-policy";

// Strategy Bullseye → objective.md rendering + file write now live in the shared
// package (arch-review §3.3) so the server preference service AND the MCP
// checked-preference-write path drive the same code — the MCP `set_preference`
// side door used to skip objective regeneration entirely. Re-exported here so this
// service's many existing importers keep their `strategy-objective.service` import
// path unchanged.
export type {
  StrategySegmentKind,
  StrategyBullseyeSegment,
  StrategyBullseyeConfig,
  MonitorTunables,
} from "@agentic-kanban/shared/lib/strategy-objective-file";
export {
  PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
  PROJECT_CONDUCTOR_STATE_RELATIVE_DIR,
  parseStrategyBullseyeConfig,
  deriveMonitorTunables,
  renderGeneratedStrategyBlock,
  updateObjectiveWithStrategy,
  renderProjectConductorObjective,
  writeStrategyObjective,
  commitObjectiveFile,
  resolveMonitorTunables,
  isBoardStrategyKey,
  projectIdFromBoardStrategyKey,
} from "@agentic-kanban/shared/lib/strategy-objective-file";

/**
 * Given a policy and live quota data, determine whether this policy is currently
 * blocked by its quota limit.
 *
 * - "fill": blocked only when the provider's usage is at or above 100% (fully exhausted).
 * - "throttle": blocked when current usage >= (100 - headroomPct)% — i.e. the headroom
 *   buffer has been consumed.
 * - "fallback-only": never blocked by quota (it's already last-resort; let it through if
 *   the caller is asking for fallbacks).
 *
 * Returns false (not blocked) when quota data is unavailable or the policy has no
 * `quotaProviderId`, so missing telemetry degrades gracefully to the static priority order.
 */
export function isPolicyBlockedByQuota(
  policy: ProviderProfilePolicy,
  quota: QuotaUsageResult | null,
): boolean {
  if (!quota || !policy.quotaProviderId) return false;
  if (policy.mode === "fallback-only") return false;

  const entry = quota.providers.find((p) => p.id === policy.quotaProviderId);
  if (!entry || entry.status !== "ok" || !entry.metrics || entry.metrics.length === 0) return false;

  // Use the highest percent across all metrics for the provider (e.g. messages vs tokens).
  const maxPercent = entry.metrics.reduce((max, m) => {
    if (m.percent == null) return max;
    return m.percent > max ? m.percent : max;
  }, 0);

  if (policy.mode === "fill") {
    return maxPercent >= 100;
  }

  // throttle: block if usage >= capacity threshold
  const threshold = 100 - policy.headroomPct;
  return maxPercent >= threshold;
}

/**
 * Select the best provider+profile for a new workspace based on the strategy config.
 *
 * Priority order:
 * 1. "fill" profiles — always keep busy, use first
 * 2. "throttle" profiles — preferred for main work
 * 3. "fallback-only" profiles — last resort
 *
 * When `quota` is provided, each policy's live usage is checked against its headroom
 * before selection. A policy blocked by quota is skipped and the next priority level
 * is tried (falling through to fallback-only when all non-fallback options are blocked).
 *
 * Returns `null` if no policies are configured (caller should use the globally-selected provider).
 * "fallback-only" profiles are only returned if `allowFallback` is true and there are no
 * other viable options.
 */
export function selectProviderFromStrategy(
  config: StrategyBullseyeConfig,
  options: { allowFallback?: boolean; quota?: QuotaUsageResult | null } = {},
): { provider: "claude" | "codex" | "copilot" | "pi"; profileName: string; policy: ProviderProfilePolicy } | null {
  const policies = config.providerPolicies ?? [];
  if (policies.length === 0) return null;

  const quota = options.quota ?? null;

  // Priority order (fill → throttle → fallback-only) is the shared
  // selectPolicyByPriority — the same logic the client's Settings preview uses —
  // with live-quota gating layered on via the isBlocked hook.
  const chosen = selectPolicyByPriority(policies, {
    allowFallback: options.allowFallback ?? false,
    isBlocked: (p) => isPolicyBlockedByQuota(p, quota),
  });
  if (!chosen) return null;
  return { provider: chosen.provider, profileName: chosen.profileName, policy: chosen };
}

/**
 * Apply a resolved provider+profile selection onto a preference map in the same
 * shape `resolveAgentSettings` expects (sets `provider` + the provider-specific
 * `*_profile` key). Shared by the fresh-workspace POST fan-out and relaunch paths.
 */
export function applyProviderSelectionToPrefMap(
  prefMap: Map<string, string>,
  selected: { provider: "claude" | "codex" | "copilot" | "pi"; profileName: string },
): void {
  if (selected.profileName) prefMap.set(getProfilePrefKey(selected.provider), selected.profileName);
  prefMap.set("provider", selected.provider);
}

/**
 * Resolve the project's *current* default provider+profile from its Strategy
 * Bullseye config, reading the `board_strategy_<projectId>` preference and
 * consulting live quota usage (the same fan-out the fresh-workspace POST does in
 * `buildAgentConfig`).
 *
 * Returns `null` when no project id is given, no strategy is configured, or the
 * config selects no provider — in which case callers should fall back to whatever
 * default they already hold (global pref or a workspace's baked value).
 *
 * Extracted so relaunch paths (fix-and-merge, conflict resolver) can honor the
 * current board default at launch time instead of trusting the provider baked
 * into the workspace record at original creation (#762).
 */
export async function resolveStrategyProviderSelection(
  database: Database,
  projectId: string | null | undefined,
): Promise<{ provider: "claude" | "codex" | "copilot" | "pi"; profileName: string; model?: string } | null> {
  if (!projectId) return null;
  const prefRows = await database.select().from(preferences);
  const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
  const strategyRaw = prefMap.get(`board_strategy_${projectId}`);
  if (!strategyRaw) return null;
  try {
    const strategyConfig = parseStrategyBullseyeConfig(strategyRaw);
    // Fetch live quota data to enable usage-aware selection; non-fatal if unavailable.
    let quota: QuotaUsageResult | null = null;
    if (strategyConfig.providerPolicies?.some((p) => p.quotaProviderId)) {
      try {
        quota = await fetchLiveQuotaUsage();
      } catch {
        /* quota service unavailable — fall back to static priority */
      }
    }
    const selected = selectProviderFromStrategy(strategyConfig, { quota });
    if (!selected) return null;
    // Carry the policy's optional model, but only when it belongs to the selected provider's
    // family — a mismatched id (e.g. a codex "gpt-5.5" on a claude policy) would otherwise be
    // passed as --model and kill the launch (#696). Mismatches are dropped here so the provider
    // default is used instead.
    const policyModel = selected.policy.model;
    const model = policyModel
      ? resolveEffectiveModel({
          prefMap: new Map(),
          provider: selected.provider,
          requestedModel: policyModel,
        }).model
      : undefined;
    return { provider: selected.provider, profileName: selected.profileName, model };
  } catch {
    return null;
  }
}
