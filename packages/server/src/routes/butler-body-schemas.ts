/**
 * Request-body schemas for `routes/butler.ts` (#806, batch 4).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * All six of the file's body reads are here. Three came in batch 4 — the three that HAD a
 * guard. The other three came in **batch 5, which OVERTURNED batch 4's rejection of them**,
 * and the correction is the useful part of this header:
 *
 * Batch 4 rejected all three on the claim that "a schema would validate nothing, because there
 * is no check to copy and every field is optional". Two thirds of that was wrong:
 *
 *   - `POST /:id/butler/model` — the recorded reason said `{ model: 7 }` "is a request that
 *     succeeds today". It is not. `normalizeModelForBackend` starts `model?.trim()`, and `?.`
 *     short-circuits on `null`/`undefined` ONLY — `(7).trim` is not a function, so `{ model: 7 }`
 *     is a **500** today.
 *   - `POST /:id/butler/profile` — `(body.profile ?? "").trim()` has the same shape and the
 *     same 500.
 *   - `PUT /:id/butler/skill` — the BRANCH reading is correct and is preserved here: an absent,
 *     null or blank prompt still DELETES the project override and answers 200. What did not
 *     follow is the conclusion. Batch 4 argued against `required("prompt is required")`, which
 *     nobody has to write; the declared type is what gets enforced, so the branch survives
 *     intact and only `{ prompt: 7 }` — a 500 today — changes, to a 400.
 *
 * So the three schemas below are the #512 declared-type tightening, exactly as batches 1–4
 * applied it elsewhere: the field the route DECLARED as a string may be given that type, and
 * the only requests whose answer changes are ones that already failed with a 500.
 *
 * `optionalStringOrNull`, not `optionalString`, in all three: `null` reaches `?? ""` / `?.` and
 * is a request that SUCCEEDS today (it selects the default model, clears the profile, deletes
 * the override), so rejecting it would be the regression this rule exists to prevent.
 */
import { z } from "zod";
import type { ButlerQuestionAnswer } from "@agentic-kanban/shared/types";
import { required, arrayOnly, requiredTrimmed, unchecked, optionalStringOrNull } from "./body-schema-helpers.js";

/**
 * `POST /api/projects/:id/butler/message`.
 *
 * The guard was `if (!body.content?.trim()) return c.json({ error: "content is required" }, 400)`,
 * so `required` (trim-tested, ORIGINAL value forwarded — `sendButlerTurn` receives
 * `body.content`, not a trimmed copy).
 */
export const butlerMessageBody = z.object({
  content: required("content is required"),
}).passthrough();

/**
 * `POST /api/projects/:id/butler/ask` — the synchronous CLI/MCP twin of `/message`, same guard.
 *
 * `timeoutMs` is read as `typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? … : 120_000`
 * — a coercion with a default, so it stays {@link unchecked}: `{ timeoutMs: "60000" }` is a
 * request that succeeds today and means "use the default".
 */
export const butlerAskBody = z.object({
  content: required("content is required"),
  timeoutMs: unchecked<number>(),
}).passthrough();

/**
 * `POST /api/projects/:id/butler/answer` (#460).
 *
 * Field order is the guard order: `askId` first, then `answers`. `requiredTrimmed`, because the
 * handler passed the TRIMMED askId to `answerButlerQuestion` — `required` would silently start
 * looking up a padded id.
 *
 * `answers` keeps `Array.isArray` + non-empty and nothing more (rule 3). The per-element shape
 * is deliberately NOT validated here: the handler filters and re-shapes each entry itself and
 * answers the SAME `answers is required` message when nothing survives that filter, so a
 * `z.array(z.object({…}))` would replace one message with zod's element-path text.
 */
export const butlerAnswerBody = z.object({
  askId: requiredTrimmed("askId is required"),
  answers: arrayOnly<ButlerQuestionAnswer>("answers is required", (v) => v.length > 0),
}).passthrough();

/**
 * `POST /api/projects/:id/butler/model`.
 *
 * No guard existed; `normalizeModelForBackend(body.model, …)` maps an unrecognised model to
 * `""` (= "let the backend choose"), and that mapping is deliberately NOT reproduced here —
 * `{ model: "gpt-9" }` must keep meaning "default", not become a 400 (rule 3). Only the
 * declared type is enforced.
 */
export const butlerModelBody = z.object({
  model: optionalStringOrNull("model must be a string"),
}).passthrough();

/**
 * `POST /api/projects/:id/butler/profile`.
 *
 * `(body.profile ?? "").trim()`: absent and `null` both mean "no profile", and an empty string
 * is the stored value for that — all three keep working.
 */
export const butlerProfileBody = z.object({
  profile: optionalStringOrNull("profile must be a string"),
}).passthrough();

/**
 * `PUT /api/projects/:id/butler/skill`.
 *
 * The handler's `if (!body.prompt?.trim())` is a BRANCH, not a guard — it deletes the
 * project-scoped override and answers 200. Absent, `null`, `""` and `"   "` therefore all stay
 * ACCEPTED and keep reverting to the global default; the schema adds nothing but the declared
 * type. This is the entry batch 4 refused, and the refusal argued against a schema nobody
 * needed to write.
 */
export const butlerSkillBody = z.object({
  prompt: optionalStringOrNull("prompt must be a string"),
}).passthrough();
