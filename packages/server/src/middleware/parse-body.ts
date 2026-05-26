import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Parses the JSON request body, throwing a 400 HTTPException on invalid/missing JSON.
 * Use this instead of manual try/catch around `c.req.json()` in route handlers.
 */
export async function parseJsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}
