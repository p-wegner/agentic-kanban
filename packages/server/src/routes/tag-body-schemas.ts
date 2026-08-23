/**
 * Request-body schemas for the `/api/tags` routes (#806).
 *
 * See `./body-schema-helpers.js` for the three rules that make this swap behaviour-preserving.
 *
 * `PATCH /api/tags/:id` is deliberately NOT here. It has no guard to copy — the whole body goes
 * to `updateTagById` — so any schema would be a pure contract change rather than a migration of
 * an existing one. It stays in the countable remainder.
 */
import { z } from "zod";
import { requiredRaw, arrayOnly, unchecked } from "./body-schema-helpers.js";

/** `POST /api/tags`. The guard was a bare `!body.name`, so no trim test (rule 3). */
export const createTagBody = z.object({
  name: requiredRaw("name is required"),
  // `color` had no guard and the route already normalises it with `?? null`, so it is left
  // alone: `z.string().nullable()` would report zod's own union message for a wrong type.
  color: unchecked<string | null>(),
}).passthrough();

/**
 * `POST /api/tags/merge`.
 *
 * ONE message for both fields, because the guard was one condition —
 * `!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0`. Splitting it into two
 * per-field messages would change what a caller sending an empty `sourceIds` is told. Key
 * order matches the guard's evaluation order: `targetId` first.
 */
export const mergeTagsBody = z.object({
  targetId: requiredRaw("targetId and sourceIds are required"),
  sourceIds: arrayOnly<string>("targetId and sourceIds are required", (v) => v.length > 0),
}).passthrough();
