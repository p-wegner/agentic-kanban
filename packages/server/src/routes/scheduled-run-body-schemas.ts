/**
 * Request-body schemas for `routes/scheduled-runs.ts` (#806, batch 4).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * `PUT /api/scheduled-runs/:id` is NOT here. It reads an untyped body forwarded whole to
 * `service.update`, whose only body check (`Invalid cron expression: …`) runs AFTER the
 * existence lookup — so a schema would answer 400 where a caller updating a run that does not
 * exist gets 404 "Not found" today. Re-ordering the answers is not a hardening.
 */
import { z } from "zod";
import { requiredRaw, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/scheduled-runs`.
 *
 * The guard is `scheduledRunService.create`'s FIRST statement —
 * `if (!body.name || !body.projectId) throw new ScheduledRunError("name and projectId are
 * required", "BAD_REQUEST")` — so nothing runs before it and the check can move to the
 * boundary without re-ordering any answer.
 *
 * ONE message on BOTH fields, because the guard was one condition: splitting it would change
 * what a caller sending only `name` is told. `requiredRaw` (bare falsy test, no trim) is what
 * `!body.name` actually was; key order is the guard's evaluation order, `name` then `projectId`.
 *
 * Every remaining field is {@link unchecked}: none was ever checked here, and `cronExpression`
 * keeps its own validation in the service, where the message is built from
 * `validateCronExpression`'s error text and carries the same `BAD_REQUEST` code.
 *
 * Declaring all eight matters beyond validation: the operation's OpenAPI property list came
 * from the `parseJsonBody<T>(c)` type argument, so a schema naming fewer fields would DELETE
 * the rest from the spec (#838).
 */
export const createScheduledRunBody = z.object({
  name: requiredRaw("name and projectId are required"),
  projectId: requiredRaw("name and projectId are required"),
  description: unchecked<string>(),
  prompt: unchecked<string>(),
  skillId: unchecked<string>(),
  intervalMinutes: unchecked<number>(),
  cronExpression: unchecked<string>(),
  enabled: unchecked<boolean>(),
}).passthrough();
