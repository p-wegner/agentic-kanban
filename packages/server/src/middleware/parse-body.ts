import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";

/**
 * The first validation message a schema produced, or a generic fallback.
 *
 * Only the FIRST is reported, because that is what the hand-written guards did — they
 * were a ladder of early returns, so a body failing three checks surfaced one message.
 * Reporting all of them would be a nicer API and a different wire contract; that is a
 * decision for whoever wants it, not a side effect of this seam.
 */
function firstIssueMessage(err: { issues: Array<{ message: string }> }): string {
  return err.issues[0]?.message ?? "invalid request body";
}

/**
 * Parses the JSON request body, throwing a 400 HTTPException on invalid/missing JSON.
 * Use this instead of manual try/catch around `c.req.json()` in route handlers.
 * Defaults to `Record<string, unknown>` (parsed JSON of unknown shape); pass an
 * explicit generic (e.g. `parseJsonBody<{ title: string }>(c)`) for a typed body.
 *
 * With a zod schema (#512) the body is CHECKED, not just asserted, and the parsed value
 * is returned already narrowed. The one-argument form asserts a type it never verifies,
 * which is why 116 hand-rolled `is required` / `must be` guards grew around it.
 *
 * The wire contract is unchanged: `domainErrorHandler` renders an HTTPException as
 * `{ error: message }` with its status — byte-identical to the `c.json({ error }, 400)`
 * the guards returned. That only holds if the SCHEMA carries the existing message, so
 * migrated schemas spell them out (`z.string().min(1, "title is required")`) rather than
 * accepting zod's defaults. A migration that lets the text drift is a contract change
 * wearing a refactor's clothes.
 */
export async function parseJsonBody<T = Record<string, unknown>>(c: Context): Promise<T>;
export async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<T>;
export async function parseJsonBody<T>(c: Context, schema?: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  if (!schema) return raw as T;

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HTTPException(400, { message: firstIssueMessage(result.error) });
  }
  return result.data;
}

/**
 * Parses the JSON request body, returning an empty object if the body is missing or invalid.
 * Use for endpoints where the request body is entirely optional.
 */
export async function parseOptionalJsonBody<T = Record<string, unknown>>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json());
  } catch {
    return {};
  }
}
