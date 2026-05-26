import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Parses the JSON request body, throwing a 400 HTTPException on invalid/missing JSON.
 * Use this instead of manual try/catch around `c.req.json()` in route handlers.
 * Defaults to `any` to match the prior `c.req.json()` behavior; pass an explicit
 * generic (e.g. `parseJsonBody<{ title: string }>(c)`) where you want a typed body.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonBody<T = any>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}
