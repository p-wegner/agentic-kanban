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

/** Preference key holding the Strategy Bullseye config JSON for a project. */
export function strategyPrefKey(projectId: string): string {
  return `board_strategy_${projectId}`;
}

/**
 * Preference key holding the selected profile for a provider (e.g. "codex" →
 * "codex_profile"). Mirrors the server-side provider registry's `profilePrefKey`
 * (locked distinct + `${provider}_profile`-shaped by agent-provider-registry.test.ts)
 * so client-safe consumers don't hand-roll the claude/codex/copilot/pi ladder —
 * the hand-rolled MCP copy fell through copilot/pi to `claude_profile` (#984).
 */
export function providerProfilePrefKey(provider: ProviderPolicyProvider): string {
  return `${provider}_profile`;
}

/**
 * Narrow an untrusted string (a stored pref, the legacy "claude-code" id) to a
 * canonical provider, defaulting to "claude" — same semantics as the server's
 * `narrowProviderName`.
 */
export function narrowPolicyProvider(value: string | null | undefined): ProviderPolicyProvider {
  const key = value === "claude-code" ? "claude" : value;
  return isProviderPolicyProvider(key) ? key : "claude";
}

/**
 * Normalize an untrusted `providerPolicies` array (already extracted from a parsed
 * JSON object) into validated `ProviderProfilePolicy[]`.
 *
 * SINGLE parser semantics (#arch-review §3.3): entries are KEPT and their missing
 * fields SYNTHESIZED (id/provider defaulted) via `normalizeProviderPolicy` — never
 * silently DROPPED. This is the exact normalizer the client Strategy Targets UI
 * uses to PERSIST the blob, so reading it back through any door (the server's
 * `parseStrategyBullseyeConfig`, the MCP `resolveProviderProfileFromPrefs`, the
 * client preview) yields the identical policy set. The server previously ran a
 * stricter private parser that dropped any entry lacking a string `id`/`provider`,
 * so the SAME `board_strategy_<id>` blob selected DIFFERENT providers depending on
 * which door read it. Both doors now funnel through here.
 */
export function normalizeProviderPolicies(raw: unknown): ProviderProfilePolicy[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => normalizeProviderPolicy(p, i));
}

/**
 * Parse the persisted `board_strategy_<projectId>` JSON into normalized provider
 * policies. Throws on malformed JSON (callers decide the fallback); a valid JSON
 * without policies yields `[]`.
 */
export function parseProviderPoliciesFromStrategy(raw: string): ProviderProfilePolicy[] {
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw) as { providerPolicies?: unknown };
  if (!parsed || typeof parsed !== "object") return [];
  return normalizeProviderPolicies(parsed.providerPolicies);
}

/** A resolved effective provider+profile decision and where it came from. */
export interface EffectiveProviderSelection {
  provider: ProviderPolicyProvider;
  profileName: string | null;
  /** Optional model pinned on the winning Bullseye policy (unvalidated — callers gate by provider family). */
  model?: string;
  source: "strategy" | "settings";
}

/**
 * The settings-prefs fallback selection: global `provider` pref narrowed, profile
 * read from THAT provider's own `<provider>_profile` key (never cross-provider).
 */
export function readSettingsProviderSelection(
  prefMap: ReadonlyMap<string, string>,
): { provider: ProviderPolicyProvider; profileName: string | null } {
  const provider = narrowPolicyProvider(prefMap.get("provider"));
  return { provider, profileName: prefMap.get(providerProfilePrefKey(provider))?.trim() || null };
}

/**
 * Resolve the EFFECTIVE default provider+profile for new work in a project — the
 * single Bullseye-aware selection core (#984), pure and client-safe (prefs in, no
 * DB, no quota fetch):
 *
 * 1. `board_strategy_<projectId>` pref → parse policies → `selectPolicyByPriority`
 *    (callers may layer live-quota gating via `isBlocked`, as the server does).
 * 2. Otherwise (no Bullseye / no selectable policy / malformed JSON): the global
 *    `provider` pref + that provider's own `<provider>_profile` key.
 *
 * Consumers: the server's new-workspace default fan-out and the MCP
 * `start_workspace` tool — which previously hand-rolled a codex→claude profile
 * ladder that ignored the Bullseye entirely and mis-keyed copilot/pi.
 */
export function resolveProviderProfileFromPrefs(
  prefMap: ReadonlyMap<string, string>,
  projectId: string | null | undefined,
  options: { allowFallback?: boolean; isBlocked?: (policy: ProviderProfilePolicy) => boolean } = {},
): EffectiveProviderSelection {
  const raw = projectId ? prefMap.get(strategyPrefKey(projectId)) : undefined;
  if (raw?.trim()) {
    try {
      const selected = selectPolicyByPriority(parseProviderPoliciesFromStrategy(raw), {
        // Match the server's selectProviderFromStrategy default: fallback-only
        // policies are not auto-selected unless explicitly allowed.
        allowFallback: options.allowFallback ?? false,
        isBlocked: options.isBlocked,
      });
      if (selected) {
        return {
          provider: selected.provider,
          profileName: selected.profileName.trim() || null,
          model: selected.model,
          source: "strategy",
        };
      }
    } catch {
      /* malformed strategy JSON — fall back to settings prefs */
    }
  }
  return { ...readSettingsProviderSelection(prefMap), source: "settings" };
}

/**
 * Provider/profile keys that participate in Bullseye divergence. A write that does
 * not touch any of these can never CREATE divergence, so the guard skips it (an
 * unrelated toggle save must never be blocked by a pre-existing, untouched drift).
 *
 * Single source of truth (#arch-review §3.3): the server `preference.service.ts`,
 * the CLI `preferences set`, and the MCP `set_preference` checked write all read
 * THIS set so the guard can never see different key lists per write door.
 */
export const PROVIDER_DIVERGENCE_KEYS: ReadonlySet<string> = new Set([
  "provider",
  "claude_profile",
  "codex_profile",
  "copilot_profile",
  "pi_profile",
]);

export interface ProviderDivergenceResult {
  hasBullseye: boolean;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
  diverged: boolean;
}

/**
 * Returned (non-null) when the write-time divergence guard (#903) rejects a
 * provider/profile write that would drift from the active project's Bullseye. No
 * preferences are persisted when this is present.
 */
export interface ProviderDivergenceRejection {
  projectId: string;
  bullseyeProvider: string | null;
  bullseyeProfile: string | null;
  settingsProvider: string | null;
  settingsProfile: string | null;
}

/**
 * Detect drift between the global provider/profile settings prefs and the project's
 * Strategy Bullseye (the single authoritative source). Pure and client-safe — prefs
 * in, no DB, no quota fetch. This is the ONE guard implementation shared by the
 * server (`resolveProviderDivergence` re-exports this), the CLI, and the MCP
 * `set_preference` checked write.
 *
 * Returns `hasBullseye: false` when no Bullseye is configured for the project (no
 * divergence possible); a malformed Bullseye JSON yields `hasBullseye: true,
 * diverged: false` (nothing to compare against).
 */
export function resolveProviderDivergence(
  prefMap: ReadonlyMap<string, string>,
  projectId: string,
): ProviderDivergenceResult {
  const strategyRaw = prefMap.get(strategyPrefKey(projectId));
  if (!strategyRaw) {
    return { hasBullseye: false, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
  }

  let bullseyeProvider: string | null = null;
  let bullseyeProfile: string | null = null;
  try {
    // Match the server's historical selection: fill → throttle → fallback-only with
    // fallback-only NOT auto-selected (allowFallback: false), no live-quota gating.
    const selected = selectPolicyByPriority(parseProviderPoliciesFromStrategy(strategyRaw), { allowFallback: false });
    if (selected) {
      bullseyeProvider = selected.provider;
      bullseyeProfile = selected.profileName || null;
    }
  } catch {
    return { hasBullseye: true, bullseyeProvider: null, bullseyeProfile: null, settingsProvider: null, settingsProfile: null, diverged: false };
  }

  const settings = readSettingsProviderSelection(prefMap);
  const providerDiverged = bullseyeProvider !== null && bullseyeProvider !== settings.provider;
  const profileDiverged = bullseyeProfile !== null && bullseyeProfile !== "" && bullseyeProfile !== settings.profileName;
  return {
    hasBullseye: true,
    bullseyeProvider,
    bullseyeProfile,
    settingsProvider: settings.provider,
    settingsProfile: settings.profileName,
    diverged: providerDiverged || profileDiverged,
  };
}
