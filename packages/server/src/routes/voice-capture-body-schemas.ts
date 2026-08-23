/**
 * Request-body schemas for `routes/voice-capture.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { requiredTrimmed, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/projects/:id/voice-capture`.
 *
 * `requiredTrimmed`, not `required`: the handler passes `body.transcript.trim()` to
 * `createVoiceCaptureIssue`, so the schema has to hand on the trimmed value too or the
 * service would start storing the padded one.
 */
export const voiceCaptureBody = z.object({
  transcript: requiredTrimmed("transcript is required"),
  speechLanguage: unchecked<string | null>(),
  speechLanguageLabel: unchecked<string | null>(),
}).passthrough();
