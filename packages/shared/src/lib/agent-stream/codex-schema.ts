import { z } from "zod";

// Schema-at-the-parse-edge for Codex CLI events (arch-review #994).
//
// These schemas do NOT replace the duck-typed extraction in codex.ts — they run
// alongside it purely to detect drift: when a KNOWN event type's payload no
// longer matches the shape the parser expects (a field rename, a shape change),
// that is reported through unknown-fields.ts instead of silently reading as
// 0/undefined via numberValue/stringValue. `.passthrough()` everywhere so
// genuinely-unknown EXTRA fields (additive CLI changes) are never flagged —
// only the fields the parser actually depends on are checked.

const tokenUsageShape = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
}).passthrough();

export const codexTurnCompletedUsageSchema = z.object({
  total_token_usage: tokenUsageShape.optional(),
  last_token_usage: tokenUsageShape.optional(),
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
}).passthrough();

export const codexThreadStartedSchema = z.object({
  thread_id: z.string(),
}).passthrough();
