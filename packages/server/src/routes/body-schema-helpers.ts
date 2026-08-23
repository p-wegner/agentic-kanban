/**
 * The predicate vocabulary shared by every `*-body-schemas.ts` in this directory (#806).
 *
 * #512 introduced this style in `issue-body-schemas.ts` and wrote the three rules that make a
 * guard→schema swap behaviour-PRESERVING rather than a silent contract change. They are
 * restated here because this module is where they are now enforced, and because every new
 * schema file is written against these helpers rather than against zod directly:
 *
 * 1. **Messages are copied verbatim, never regenerated.** `domainErrorHandler` renders an
 *    `HTTPException` as `{ error: message }` with its status, so a `c.json({ error }, 400)`
 *    guard and a schema rejection are byte-identical on the wire — *provided the TEXT is the
 *    same*. zod's defaults ("Required", "Expected string, received number") are not what these
 *    endpoints have always said, so every helper below takes the message as its first argument
 *    and there is deliberately no default.
 * 2. **Field order matches the old guard order.** The guards were ladders of early returns, so
 *    only the FIRST failure was ever reported; `parseJsonBody` keeps that by surfacing only the
 *    first zod issue. zod walks an object schema in key order, so a reordered schema silently
 *    changes which message a caller sees. Declare fields in the order the guards ran.
 * 3. **Predicates are copied, not tightened.** `Array.isArray` stays `Array.isArray`;
 *    `typeof x === "number"` stays that and does NOT become `z.number()` (which rejects `NaN`
 *    that the guard accepted). Validating more than the guard did rejects bodies these routes
 *    accept today, which is a contract change wearing a refactor's clothes.
 *
 * The one sanctioned tightening, inherited from #512: a field the route DECLARED as `string`
 * (or `boolean`, or `string | null`) but never checked may be given that declared type, so a
 * request sending the wrong primitive gets a 400 instead of having it passed downstream. That
 * matches the type the route already claimed. Anything with structure — an array's elements, a
 * record's values — is left alone via {@link unchecked}, per rule 3.
 *
 * **Use `.passthrough()` on any schema whose handler forwards the WHOLE body to a service.**
 * A bare `z.object()` STRIPS unknown keys from `result.data`, so `service.create(id, body)`
 * would silently start receiving fewer fields than it does today — a behaviour change invisible
 * at the call site. Passthrough costs nothing and removes the whole class.
 */
import { z } from "zod";

/**
 * A required, non-blank string carrying the guard's exact message — the schema form of
 * `if (!body.x?.trim()) return c.json({ error: message }, 400)`.
 *
 * `.refine`, not `.trim()`: those guards tested the trimmed value but passed the ORIGINAL on,
 * so trimming here would change what the service receives.
 */
export function required(message: string) {
  return z
    .string({ required_error: message, invalid_type_error: message })
    .refine((v) => v.trim().length > 0, message);
}

/**
 * A present, non-blank string with no trim test — the schema form of a bare falsy check,
 * `if (!body.x) return c.json({ error: message }, 400)`.
 */
export function requiredRaw(message: string) {
  return z.string({ required_error: message, invalid_type_error: message }).min(1, message);
}

/**
 * `Array.isArray` and nothing more, preserving the element type the route declared.
 * Deliberately NOT `z.array(elementSchema)` — see rule 3 above. `extra` carries any additional
 * predicate the same guard applied (typically a length test), so that one combined guard stays
 * one combined message.
 */
export function arrayOnly<T>(message: string, extra?: (v: unknown[]) => boolean) {
  return z.custom<T[]>((v) => Array.isArray(v) && (extra ? extra(v) : true), { message });
}

/**
 * `typeof v === "string"` and nothing more, for an optional field — the schema form of
 * `if (body.x !== undefined && typeof body.x !== "string") return c.json({ error }, 400)`.
 *
 * `.optional()` short-circuits before the check runs, which is exactly the `!== undefined`
 * half of that guard.
 */
export function optionalString(message: string) {
  return z.custom<string>((v) => typeof v === "string", { message }).optional();
}

/**
 * `v === null || typeof v === "string"`, optional — the schema form of
 * `if (body.x !== undefined && body.x !== null && typeof body.x !== "string") …`.
 *
 * Written as a `custom` rather than `z.string().nullable().optional()` on purpose: the union
 * form reports zod's own "Invalid input" for the null branch instead of the guard's message,
 * which is rule 1.
 */
export function optionalStringOrNull(message: string) {
  return z
    .custom<string | null>((v) => v === null || typeof v === "string", { message })
    .optional();
}

/**
 * `typeof v === "number"`, nothing more — NOT `z.number()`, which additionally rejects `NaN`
 * that `typeof body.x !== "number"` accepted (rule 3).
 */
export function numberOnly(message: string) {
  return z.custom<number>((v) => typeof v === "number", { message });
}

/**
 * A field the route declares but never checked, whose type has STRUCTURE (an array's elements,
 * a record's values). It validates nothing and carries the declared type only.
 *
 * This is not laziness, it is rule 3 made explicit: `z.record(z.string())` or
 * `z.array(z.object({…}))` here would reject bodies these routes accept today. The declared
 * type is documentation of intent; the guard never enforced it and neither does this. A field
 * that SHOULD be checked gets a real predicate and a message chosen deliberately, not by
 * default.
 */
export function unchecked<T>() {
  return z.custom<T>(() => true).optional();
}

/**
 * `typeof v === "string"` and nothing more, REQUIRED — the string analogue of
 * {@link numberOnly}, and the type-only sibling of {@link requiredRaw}.
 *
 * Reach for this instead of `requiredRaw` when the route declared the field as `string` but
 * never guarded it. `requiredRaw`'s `.min(1)` would reject the empty string, which such a
 * route accepts today (it forwards it); this rejects only `undefined` and the wrong primitive,
 * which is exactly the declared-type tightening rule 3's exception sanctions.
 */
export function stringOnly(message: string) {
  return z.custom<string>((v) => typeof v === "string", { message });
}

/**
 * A required, non-blank string that ALSO returns the trimmed value — the schema form of
 * `const x = typeof body.x === "string" ? body.x.trim() : ""; if (!x) return 400`.
 *
 * The transform is not decoration: those guards passed the TRIMMED value on to the service,
 * so `required` (which deliberately preserves the original, because the guards it was written
 * for did) would silently start handing services `" abc "` where they receive `"abc"` today —
 * a behaviour change on a request that SUCCEEDS, which is the one thing rule 1 forbids. Two
 * spellings exist because the two guard shapes genuinely differ; pick the one your guard used.
 */
export function requiredTrimmed(message: string) {
  return z
    .string({ required_error: message, invalid_type_error: message })
    .refine((v) => v.trim().length > 0, message)
    .transform((v) => v.trim());
}
