/**
 * Request-body schemas for `routes/flaky-tests.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * `DELETE /api/flaky-tests/pin` is NOT here on purpose: it reads its body with
 * `parseOptionalJsonBody`, so a MISSING body reaches its own `testName is required` 400.
 * Routing it through `parseJsonBody` would answer `invalid JSON body` instead — a different
 * message for the same request, which is the one thing the swap rule forbids.
 */
import { z } from "zod";
import { requiredRaw, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/flaky-tests/parse`.
 *
 * `sessionId` and `output` share ONE message because the guard was a single
 * `if (!body.sessionId || !body.output)`. `runner` keeps no predicate: `parseTestOutput`
 * treats anything but `"playwright"` as vitest, so an unknown value is handled, not refused.
 */
export const flakyParseBody = z.object({
  sessionId: requiredRaw("sessionId and output are required"),
  commitSha: unchecked<string>(),
  output: requiredRaw("sessionId and output are required"),
  runner: unchecked<"vitest" | "playwright">(),
}).passthrough();

/** `POST /api/flaky-tests/pin`. */
export const flakyPinBody = z.object({
  testName: requiredRaw("testName is required"),
  file: unchecked<string>(),
}).passthrough();
