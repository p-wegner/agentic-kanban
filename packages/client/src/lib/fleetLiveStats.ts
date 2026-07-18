/**
 * Fleet live-stats aggregator — the pure reducer behind the FleetTokenMeter.
 *
 * The board already delivers per-issue live agent stats over the board-events
 * WebSocket (`session_stats` → `Record<issueId, LiveSessionStats>`, owned by
 * `useBoardRealtimeController` and pruned to the active project's *active*
 * workspaces). This module reduces that per-issue map into a single fleet-wide
 * view: total in-flight context tokens, active agent count, a per-provider /
 * per-model split, and a running estimated cost.
 *
 * ## Why cost is estimated here (and not "reused")
 * The ticket asked to reuse the pricing helper behind `workspaces/cost-over-time`.
 * That feature does NOT price tokens — it sums each session's provider-reported
 * `stats.totalCostUsd` (a historical value persisted per session). The LIVE
 * `session_stats` WS event carries only `{ model, contextTokens, toolUses,
 * subagentCount }` — no cost field — so a live estimate cannot come from that
 * path. There is no per-token price table anywhere in the repo to import. So we
 * derive a best-effort live estimate from `model` + `contextTokens` using the
 * small published-list-price table below. It is an ESTIMATE of the input cost of
 * each agent's current context, clearly labelled as such in the UI.
 */

import { modelBelongsToProvider } from "@agentic-kanban/shared/lib";

export type FleetProvider = "claude" | "codex" | "copilot" | "pi" | "unknown";

/**
 * Approximate published INPUT-token list prices, USD per 1M tokens, keyed by
 * model family. Used only to turn a live `contextTokens` occupancy into a rough
 * running cost — NOT billing-grade. Kept in one place so it is easy to update
 * when list prices change; do not scatter prices elsewhere.
 */
const MODEL_INPUT_USD_PER_MTOK: ReadonlyArray<{ match: (id: string) => boolean; usd: number }> = [
  // Claude tiers (short ids from the model picker + explicit claude-* ids).
  { match: (id) => id === "opus" || id.includes("claude-opus"), usd: 15 },
  { match: (id) => id === "sonnet" || id.includes("claude-sonnet"), usd: 3 },
  { match: (id) => id === "haiku" || id.includes("claude-haiku"), usd: 1 },
  { match: (id) => id.includes("fable"), usd: 3 },
  // Codex / GPT-5 family (list input price for the flagship; minis are cheaper).
  { match: (id) => id.includes("mini"), usd: 0.25 },
  { match: (id) => id.startsWith("gpt-5") || id.includes("codex"), usd: 1.25 },
  { match: (id) => id.startsWith("gpt-4o"), usd: 2.5 },
  { match: (id) => id.startsWith("gpt-"), usd: 2.5 },
];

/** Fallback input price (USD/MTok) for an unrecognised model — a conservative mid value. */
const DEFAULT_INPUT_USD_PER_MTOK = 3;

/**
 * Best-effort USD cost of holding `contextTokens` input tokens for `model`.
 * Returns 0 for empty/zero input. This is the single sanctioned live-cost
 * estimator; inject it into the reducer to keep the reducer deterministic.
 */
export function estimateContextCostUsd(model: string | null | undefined, contextTokens: number): number {
  if (!contextTokens || contextTokens <= 0) return 0;
  const id = (model ?? "").trim().toLowerCase();
  const entry = MODEL_INPUT_USD_PER_MTOK.find((e) => e.match(id));
  const perMtok = entry ? entry.usd : DEFAULT_INPUT_USD_PER_MTOK;
  return (contextTokens / 1_000_000) * perMtok;
}

/**
 * Map a runtime model string to its provider label. Mirrors the prefix rules in
 * `shared/lib/provider-models.ts` (`modelBelongsToProvider`), which we reuse to
 * disambiguate the Claude/Codex families, then fall back to name heuristics for
 * copilot/pi and `"unknown"` for anything unrecognised.
 */
export function providerForModel(model: string | null | undefined): FleetProvider {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return "unknown";
  // modelBelongsToProvider is permissive (unknown ids pass every provider), so
  // only trust its NEGATIVE answers to split the two families it actually knows.
  const isCodex = !modelBelongsToProvider(id, "claude"); // rejected by claude ⇒ codex-family id
  const isClaude = !modelBelongsToProvider(id, "codex"); // rejected by codex ⇒ claude-family id
  if (isClaude) return "claude";
  if (isCodex) return "codex";
  if (id.includes("copilot")) return "copilot";
  if (id.includes("pi")) return "pi";
  return "unknown";
}

/** One active agent's live contribution, joined with its issue metadata. */
export interface FleetAgentInput {
  issueId: string;
  issueNumber: number | null;
  title: string;
  model: string;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
  /** Whether the agent is still live. Idle agents are excluded from the fleet totals. */
  active: boolean;
  /** Most recent tool/activity label, if known. */
  lastTool?: string | null;
}

/** A per-provider or per-model rollup row. */
export interface FleetSplitEntry {
  key: string;
  agentCount: number;
  contextTokens: number;
  estimatedCostUsd: number;
}

/** One row in the expanded per-agent breakdown. */
export interface FleetAgentBreakdown {
  issueId: string;
  issueNumber: number | null;
  title: string;
  model: string;
  provider: FleetProvider;
  contextTokens: number;
  toolUses: number;
  subagentCount: number;
  estimatedCostUsd: number;
  lastTool: string | null;
}

/** The fleet-wide aggregate consumed by the meter. */
export interface FleetLiveStatsAggregate {
  activeAgentCount: number;
  totalContextTokens: number;
  totalToolUses: number;
  totalSubagents: number;
  estimatedCostUsd: number;
  /** Per-provider split, highest context first. */
  byProvider: FleetSplitEntry[];
  /** Per-model split, highest context first. */
  byModel: FleetSplitEntry[];
  /** Per-agent breakdown, highest context first. */
  agents: FleetAgentBreakdown[];
}

const EMPTY_AGGREGATE: FleetLiveStatsAggregate = {
  activeAgentCount: 0,
  totalContextTokens: 0,
  totalToolUses: 0,
  totalSubagents: 0,
  estimatedCostUsd: 0,
  byProvider: [],
  byModel: [],
  agents: [],
};

function accumulate(
  map: Map<string, FleetSplitEntry>,
  key: string,
  contextTokens: number,
  costUsd: number,
): void {
  const existing = map.get(key);
  if (existing) {
    existing.agentCount += 1;
    existing.contextTokens += contextTokens;
    existing.estimatedCostUsd += costUsd;
  } else {
    map.set(key, { key, agentCount: 1, contextTokens, estimatedCostUsd: costUsd });
  }
}

/**
 * Reduce per-agent live inputs to a single fleet-wide aggregate. Only agents
 * with `active: true` contribute — an agent going idle drops out of every total
 * and split. `priceFn` is injectable so tests stay deterministic.
 */
export function aggregateFleetLiveStats(
  inputs: FleetAgentInput[],
  priceFn: (model: string | null | undefined, contextTokens: number) => number = estimateContextCostUsd,
): FleetLiveStatsAggregate {
  const active = inputs.filter((i) => i.active);
  if (active.length === 0) return EMPTY_AGGREGATE;

  const byProvider = new Map<string, FleetSplitEntry>();
  const byModel = new Map<string, FleetSplitEntry>();
  const agents: FleetAgentBreakdown[] = [];

  let totalContextTokens = 0;
  let totalToolUses = 0;
  let totalSubagents = 0;
  let estimatedCostUsd = 0;

  for (const input of active) {
    const contextTokens = Math.max(0, input.contextTokens || 0);
    const cost = priceFn(input.model, contextTokens);
    const provider = providerForModel(input.model);

    totalContextTokens += contextTokens;
    totalToolUses += Math.max(0, input.toolUses || 0);
    totalSubagents += Math.max(0, input.subagentCount || 0);
    estimatedCostUsd += cost;

    accumulate(byProvider, provider, contextTokens, cost);
    accumulate(byModel, input.model || "unknown", contextTokens, cost);

    agents.push({
      issueId: input.issueId,
      issueNumber: input.issueNumber,
      title: input.title,
      model: input.model,
      provider,
      contextTokens,
      toolUses: Math.max(0, input.toolUses || 0),
      subagentCount: Math.max(0, input.subagentCount || 0),
      estimatedCostUsd: cost,
      lastTool: input.lastTool ?? null,
    });
  }

  const byContextDesc = (a: FleetSplitEntry, b: FleetSplitEntry) => b.contextTokens - a.contextTokens;

  return {
    activeAgentCount: active.length,
    totalContextTokens,
    totalToolUses,
    totalSubagents,
    estimatedCostUsd,
    byProvider: [...byProvider.values()].sort(byContextDesc),
    byModel: [...byModel.values()].sort(byContextDesc),
    agents: agents.sort((a, b) => b.contextTokens - a.contextTokens),
  };
}
