import { z } from "zod";

// Schema-at-the-parse-edge for Pi CLI turn-end usage (arch-review #994). Runs
// alongside the existing extractPiUsage() duck-typing purely to detect drift:
// a rename inside `message.usage` reads as a silent 0 via numberValue's
// finite-number-or-0 default. `.passthrough()` so additive/unknown extra
// fields are never flagged.

export const piUsageSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
}).passthrough();

/** True when neither `input` nor `output` is present on the usage object. */
export function piUsageLacksTokenFields(usage: Record<string, unknown>): boolean {
  return typeof usage.input !== "number" && typeof usage.output !== "number";
}
