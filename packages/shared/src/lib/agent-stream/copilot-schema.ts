import { z } from "zod";

// Schema-at-the-parse-edge for Copilot CLI result/session-end events
// (arch-review #994). Copilot's parser (copilot.ts) is the most
// shape-guessing of the four providers — 12 normalized spellings for
// "result"/"session end" (copilot-event-types.ts), and until now `success` was
// inferred purely from the ABSENCE of an error signal (a missing `exitCode`
// read as `0` via `Number(payload.exitCode ?? 0) === 0`, so any renamed error
// field defaulted straight to "success"). This schema does not replace the
// existing duck-typed extraction; it validates the fields the success/token
// computation actually depends on, so a rename is reported as drift instead of
// silently reading as success/0-tokens.

export const copilotResultPayloadSchema = z.object({
  exitCode: z.number().optional(),
  is_error: z.boolean().optional(),
  isError: z.boolean().optional(),
  error: z.unknown().optional(),
  status: z.string().optional(),
  subtype: z.string().optional(),
}).passthrough();

/** True when the payload carries at least one field the success computation reads. */
export function hasCopilotSuccessSignalFields(payload: Record<string, unknown>): boolean {
  return payload.exitCode !== undefined
    || payload.is_error !== undefined
    || payload.isError !== undefined
    || payload.error !== undefined
    || payload.status !== undefined
    || payload.subtype !== undefined;
}
