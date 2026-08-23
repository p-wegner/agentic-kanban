/**
 * Request-body schemas for `routes/failure-patterns.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { required, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/failure-patterns`.
 *
 * `title` is {@link required}, not `requiredTrimmed`: the guard tested `body.title?.trim()`
 * and passed the ORIGINAL to `createPattern`. Every other field is `?? null`-defaulted by the
 * handler and was never checked, so it keeps its declared type and no predicate.
 */
export const failurePatternBody = z.object({
  title: required("title is required"),
  errorClass: unchecked<string>(),
  description: unchecked<string>(),
  rootCause: unchecked<string>(),
  fix: unchecked<string>(),
  sourceType: unchecked<string>(),
  sourceRef: unchecked<string>(),
}).passthrough();

/** `POST /api/failure-patterns/ingest`. Trim-tested, original value forwarded — as above. */
export const failurePatternIngestBody = z.object({
  filePath: required("filePath is required"),
}).passthrough();
