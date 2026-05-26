import { Hono } from "hono";
import { domainErrorHandler } from "./error-handler.js";

/** Creates a Hono router with the domain error handler pre-applied. */
export function createRouter(): Hono {
  const router = new Hono();
  router.onError(domainErrorHandler);
  return router;
}
