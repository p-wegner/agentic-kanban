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

// --- assistant event + system/init (arch-review §2.2) ----------------------
//
// Two more inner-field drift sites the review flagged (claude.ts:16,:84,:89):
//   - the assistant event's `message.usage` feeds liveStats.contextTokens; a
//     token-field rename silently zeroes it (numberValue default) — the same
//     "0 tokens" class re-fixed field-by-field in #976/#994;
//   - the assistant event's `message.content` array feeds assistantText; a
//     content-shape change silently drops it → hadSubstantiveOutput false →
//     completed runs misclassified as launch failures;
//   - the system/init event's `session_id` drives the resume chain; a rename
//     reads identically to "no session id" and silently breaks resume.
// These schemas run ALONGSIDE the duck-typed extraction (never replacing it),
// purely to attach zod issue paths to a reported drift. `.passthrough()` so
// additive CLI fields are never flagged.

const assistantUsageShape = z.object({
  input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
}).partial().passthrough();

export const claudeAssistantMessageSchema = z.object({
  usage: assistantUsageShape.optional(),
  content: z.array(z.unknown()),
}).passthrough();

export const claudeSystemInitSchema = z.object({
  session_id: z.string().min(1),
}).passthrough();

/**
 * True when a PRESENT `message.usage` object carries neither token field the
 * contextTokens computation depends on (`input_tokens` / `cache_read_input_tokens`).
 * An ABSENT usage object is a HEALTHY assistant message (e.g. a tool_use-only
 * turn) — NOT drift — so only a present-but-renamed usage is flagged.
 */
export function claudeAssistantUsageLacksTokenFields(message: Record<string, unknown>): boolean {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return false;
  const record = usage as Record<string, unknown>;
  if (Object.keys(record).length === 0) return false;
  return typeof record.input_tokens !== "number" && typeof record.cache_read_input_tokens !== "number";
}

/**
 * True when a present assistant `message` carries a `content` field that is not
 * the array of blocks the text/tool extraction depends on (a shape drift). An
 * empty message object is left to the caller (a missing message is a different
 * signal); only a present message with a non-array `content` is flagged.
 */
export function claudeAssistantContentShapeDrifted(message: Record<string, unknown>): boolean {
  if (Object.keys(message).length === 0) return false;
  return !Array.isArray(message.content);
}

/**
 * Render zod issue paths for a drift log detail, or a fallback when the lenient
 * schema still matched. Schema-agnostic: any `safeParse` result is accepted (the
 * schemas here are `.passthrough()`/`.optional()` so success is the common case
 * and the boolean helpers above are what actually detect the drift).
 */
export function describeClaudeDrift(
  parsed: { success: true } | { success: false; error: z.ZodError },
  matchedButEmpty: string,
): string {
  return parsed.success
    ? matchedButEmpty
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
