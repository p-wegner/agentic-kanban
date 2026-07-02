import { z } from "zod";

// Schema-at-the-parse-edge for Claude Code CLI `result` events (arch-review
// #994). Runs alongside the existing duck-typed extraction in claude.ts purely
// to detect drift: a rename inside the `usage`/`modelUsage` shape the stats
// computation depends on currently reads as a silent 0 via numberValue's
// finite-number-or-0 default. `.passthrough()` so additive/unknown extra
// fields are never flagged.

const tokenUsageShape = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
}).passthrough();

export const claudeResultUsageSchema = z.object({
  usage: tokenUsageShape.partial().passthrough().optional(),
  modelUsage: z.record(z.string(), z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
  }).passthrough()).optional(),
}).passthrough();

function hasTokenFields(usage: Record<string, unknown> | undefined): boolean {
  if (!usage) return false;
  return typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number";
}

function hasModelUsageTokenFields(modelUsage: Record<string, unknown> | undefined): boolean {
  if (!modelUsage) return false;
  return Object.values(modelUsage).some((entry) => {
    const record = entry as Record<string, unknown>;
    return typeof record?.inputTokens === "number" || typeof record?.outputTokens === "number";
  });
}

/** True when neither the flat `usage` nor any `modelUsage` entry carries a token field. */
export function claudeResultLacksTokenFields(obj: Record<string, unknown>): boolean {
  const usage = obj.usage as Record<string, unknown> | undefined;
  const modelUsage = obj.modelUsage as Record<string, unknown> | undefined;
  return !hasTokenFields(usage) && !hasModelUsageTokenFields(modelUsage);
}
