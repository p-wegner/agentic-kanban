/**
 * Context-window occupancy helpers — the data behind the "/context"-like view.
 *
 * "Context tokens" follows the codebase-wide convention (see
 * `server/src/routes/insights.ts` `contextTokensFor` and
 * `shared/src/services/session-stats.service.ts`): the stats' `contextTokens`
 * if present, otherwise `inputTokens + cacheReadTokens` — the tokens that
 * actually occupy the model's context window, NOT output tokens.
 */

/** Anthropic's default context window — the same fallback the butler uses. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Best-effort context-window size (in tokens) for a model name. Most agent
 * providers report a model string in session stats; we map the well-known ones
 * and fall back to the 200k Anthropic default. This is only used as the bar's
 * denominator — occupancy numbers themselves come from real usage counts.
 */
export function contextWindowForModel(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const m = model.toLowerCase();
  // Claude 1M-context variants (e.g. the "[1m]" model ids).
  if (m.includes("[1m]") || m.includes("-1m")) return 1_000_000;
  // GPT / o-series and Gemini families commonly expose larger windows.
  if (m.includes("gemini")) return 1_000_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.includes("codex")) return 400_000;
  if (m.includes("gpt-4o") || m.includes("gpt-4-turbo")) return 128_000;
  // Claude family (opus / sonnet / haiku) and everything else.
  return DEFAULT_CONTEXT_WINDOW;
}

export interface ContextOccupancy {
  /** Tokens occupying the context window (input + cache-read, or explicit). */
  contextTokens: number;
  /** Output tokens produced (not part of occupancy, shown for context). */
  outputTokens: number;
  /** The model that ran, if known. */
  model: string | null;
  /** The model's context-window size, used as the bar denominator. */
  contextWindow: number;
  /** Fraction of the window occupied, clamped to [0, 1]. */
  fraction: number;
}

interface RawStats {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  contextTokens?: unknown;
  model?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Compute occupancy from a session's `stats` JSON string (historical). */
export function occupancyFromStatsJson(statsStr: string | null | undefined): ContextOccupancy | null {
  if (!statsStr) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(statsStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as RawStats;
  const explicit = num(s.contextTokens);
  const contextTokens = explicit || num(s.inputTokens) + num(s.cacheReadTokens);
  if (contextTokens <= 0) return null;
  const model = typeof s.model === "string" && s.model ? s.model : null;
  return buildOccupancy(contextTokens, num(s.outputTokens), model);
}

/** Compute occupancy from live session stats (active session). */
export function occupancyFromLive(
  contextTokens: number,
  model: string | null | undefined,
): ContextOccupancy | null {
  if (!contextTokens || contextTokens <= 0) return null;
  return buildOccupancy(contextTokens, 0, model ?? null);
}

function buildOccupancy(contextTokens: number, outputTokens: number, model: string | null): ContextOccupancy {
  const contextWindow = contextWindowForModel(model);
  const fraction = Math.max(0, Math.min(1, contextTokens / contextWindow));
  return { contextTokens, outputTokens, model, contextWindow, fraction };
}

/** Tailwind color classes for an occupancy fraction (green → amber → red). */
export function occupancyColor(fraction: number): { bar: string; text: string } {
  if (fraction >= 0.9) return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
  if (fraction >= 0.7) return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
  return { bar: "bg-brand-500", text: "text-brand-600 dark:text-brand-400" };
}
