/**
 * Request-body schemas for `routes/butler.ts` (#806, batch 4).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 *
 * Three of the file's six body reads are here — the three that HAD a guard. The other three
 * are rejected rather than deferred, and the reason is the same for all of them: a schema
 * would validate nothing, because there is no check to copy and every field is optional.
 *
 *   - `POST /:id/butler/model` — `normalizeModelForBackend(body.model, …)` normalises whatever
 *     arrives; `{ model: 7 }` is a request that succeeds today.
 *   - `POST /:id/butler/profile` — `(body.profile ?? "").trim()`, a coercion, not a check.
 *   - `PUT /:id/butler/skill` — `if (!body.prompt?.trim())` looks like a guard and is a
 *     BRANCH: an empty prompt DELETES the project override and answers 200. Making it
 *     `required("prompt is required")` would turn the documented way to revert to the global
 *     default into a 400.
 *
 * An all-`unchecked` schema for those three would move the ratchet's number without changing
 * what any of them accepts, and the spec already carries their property list from the type
 * argument — so it would buy nothing on either side. They keep their slots in the census.
 */
import { z } from "zod";
import type { ButlerQuestionAnswer } from "@agentic-kanban/shared/types";
import { required, arrayOnly, requiredTrimmed, unchecked } from "./body-schema-helpers.js";

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
