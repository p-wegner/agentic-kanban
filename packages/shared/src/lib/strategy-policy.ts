/**
 * Provider profile policy — the per-provider routing entry persisted inside the
 * `board_strategy_<projectId>` preference (Strategy Bullseye config).
 *
 * SINGLE source of truth for the policy shape (#983). The server
 * (`strategy-objective.service.ts`) and the client (`strategy-targets.ts`)
 * previously each hand-maintained a same-named interface; the client copy was
 * missing `model`, and its field-list normalizer silently DROPPED any per-policy
 * model the server had written on every Strategy Targets save (a provider-stall
 * class that already caused an outage). Both sides now import THIS definition.
 *
 * Client-safe: no node imports — safe to reach from the browser bundle via the
 * deep path `@agentic-kanban/shared/lib/strategy-policy`.
 */

export const PROVIDER_POLICY_PROVIDERS = ["claude", "codex", "copilot", "pi"] as const;
export type ProviderPolicyProvider = (typeof PROVIDER_POLICY_PROVIDERS)[number];

/**
 * Rate-limit policy mode for a single provider profile.
 *
 * - "fill": use aggressively — keep busy at all times (e.g. time-windowed plans with cheap resets)
 * - "throttle": use for main work but preserve headroom (e.g. 5h/week plans shared with other projects)
 * - "fallback-only": only use when no better option exists, or on explicit user action (e.g. token-based gateways)
 */
export const PROVIDER_POLICY_MODES = ["fill", "throttle", "fallback-only"] as const;
export type ProviderPolicyMode = (typeof PROVIDER_POLICY_MODES)[number];

export interface ProviderProfilePolicy {
  /** Unique key: "{provider}:{profileName}" — e.g. "claude:work", "codex:default" */
  id: string;
  provider: ProviderPolicyProvider;
  profileName: string;
  /** Human-readable label, e.g. "Claude (andrena gateway)" */
  label: string;
  mode: ProviderPolicyMode;
  /** 0–100. Only applies when mode="throttle". Leave this % of the rate-limit window unused. */
  headroomPct: number;
  /** Informational note shown in the UI and emitted into objective.md */
  notes: string;
  /**
   * Optional ID of the corresponding quota provider from the tampermonkey-direct
   * `/api/usage` response. When set and live quota data is available, the orchestrator
   * checks real usage against headroomPct (throttle) or max-out (fill) before
   * selecting this policy. Blank/absent skips usage-based gating for this policy.
   */
  quotaProviderId?: string;
  /**
   * Optional model id this policy launches with (e.g. "sonnet" for claude, "gpt-5.5" for codex).
   * Lets a project pin a model WITHOUT the global `default_model` preference, which applies to
   * every provider and every project (the #696 cross-provider footgun). When set, it is threaded
   * into new-workspace creation as the `requestedModel` for this policy's provider; an explicit
   * per-workspace model still wins, and a model that doesn't belong to the provider is dropped.
   */
  model?: string;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function isProviderPolicyProvider(value: unknown): value is ProviderPolicyProvider {
  return typeof value === "string" && (PROVIDER_POLICY_PROVIDERS as readonly string[]).includes(value);
}

function isProviderPolicyMode(value: unknown): value is ProviderPolicyMode {
  return typeof value === "string" && (PROVIDER_POLICY_MODES as readonly string[]).includes(value);
}

/**
 * Normalize one persisted/edited provider policy entry into a valid
 * `ProviderProfilePolicy` — the round-trip codec the client uses before saving
 * `board_strategy_<projectId>`.
 *
 * Round-trip safety (#983): the INPUT is spread first, so unknown fields written
 * by a newer server survive an open→save cycle in the Strategy Targets UI instead
 * of being rebuilt from a hardcoded field list. Known fields are then validated
 * and overwritten; `model` is preserved when it is a non-blank string and removed
 * when invalid/blank.
 */
export function normalizeProviderPolicy(raw: unknown, index: number): ProviderProfilePolicy {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<ProviderProfilePolicy> & Record<string, unknown>;
  const provider: ProviderPolicyProvider = isProviderPolicyProvider(p.provider) ? p.provider : "claude";
  const profileName = typeof p.profileName === "string" ? p.profileName : "";
  const normalized: ProviderProfilePolicy = {
    // Preserve unknown/future fields on round-trip so a client save never eats
    // server-side additions (the `model` drop was exactly this failure).
    ...p,
    id: typeof p.id === "string" && p.id ? p.id : `policy-${provider}-${profileName || index}`,
    provider,
    profileName,
    label:
      typeof p.label === "string" && p.label.trim()
        ? p.label
        : `${provider}${profileName ? `:${profileName}` : ""}`,
    mode: isProviderPolicyMode(p.mode) ? p.mode : "throttle",
    headroomPct: clampNumber(p.headroomPct ?? 20, 20, 0, 100),
    notes: typeof p.notes === "string" ? p.notes : "",
    quotaProviderId: typeof p.quotaProviderId === "string" ? p.quotaProviderId : "",
  };
  if (typeof p.model === "string" && p.model.trim()) {
    normalized.model = p.model.trim();
  } else {
    delete normalized.model;
  }
  return normalized;
}

/**
 * Priority-order policy selection shared by the server's
 * `selectProviderFromStrategy` (which adds live-quota gating via `isBlocked`)
 * and the client's `selectProviderFromPolicies` preview: fill → throttle →
 * fallback-only. Returns `null` when nothing is selectable.
 *
 * - `isBlocked` lets the caller veto individual fill/throttle policies (e.g.
 *   quota exhaustion). Fallback-only policies are never quota-gated.
 * - `allowFallback` (default true) gates whether fallback-only policies may be
 *   returned at all.
 */
export function selectPolicyByPriority(
  policies: ProviderProfilePolicy[],
  options: { allowFallback?: boolean; isBlocked?: (policy: ProviderProfilePolicy) => boolean } = {},
): ProviderProfilePolicy | null {
  const blocked = options.isBlocked ?? (() => false);
  const fill = policies.find((p) => p.mode === "fill" && !blocked(p));
  if (fill) return fill;
  const throttle = policies.find((p) => p.mode === "throttle" && !blocked(p));
  if (throttle) return throttle;
  if (options.allowFallback ?? true) {
    const fallback = policies.find((p) => p.mode === "fallback-only");
    if (fallback) return fallback;
  }
  return null;
}
