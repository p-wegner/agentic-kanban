import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createButlerDefinitionBody } from "./butler-definitions-body-schemas.js";
import {
  listButlerDefinitions,
  createButlerDefinition,
  updateButlerDefinition,
  deleteButlerDefinition,
  ButlerDefinitionError,
  MAX_BUTLERS,
} from "../services/butler-definitions.service.js";

/**
 * Butler definitions CRUD — the GLOBAL set of named butlers (e.g. "Smart"/opus,
 * "Quick"/haiku), shared across all projects. Mounted at /api/butler-definitions.
 * Per-project warm-session state lives under /api/projects/:id/butlers (butler.ts).
 */
export function createButlerDefinitionsRoute(database: Database) {
  const router = createRouter();

  /**
   * `parseJsonBody(c, schema)` with this route file's ERROR IDENTITY preserved (#806, batch 5)
   * — the same wrapper `routes/plugins.ts` grew in batch 2 and `routes/milestones.ts` in
   * batch 4, for the same reason.
   *
   * The guard this replaces threw `ButlerDefinitionError("Butler name is required",
   * "BAD_REQUEST")`, which `domainErrorHandler` renders as `{ error, code: "BAD_REQUEST" }` at
   * 400 (#823). A bare schema swap throws `HTTPException`, whose body is `{ error }` alone, so
   * it would silently drop `code`. Status and message are byte-identical either way.
   *
   * It must stay a SAME-FILE local: `scripts/generate-openapi.ts` follows exactly one hop via
   * `findFunctionNamed(sf, …)`, so a shared wrapper module would delete this operation's
   * request-body property list from the generated spec.
   *
   * The one knowing difference, inherited from `parsePluginBody`: an unparseable body
   * ("invalid JSON body", raised before the schema runs) now carries `code: "BAD_REQUEST"` too
   * — a field ADDED to a response that was already a 400 on a request that could never have
   * succeeded.
   */
  async function parseButlerDefinitionBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
    try {
      return await parseJsonBody(c, schema);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 400) {
        throw new ButlerDefinitionError(err.message, "BAD_REQUEST");
      }
      throw err;
    }
  }

  // GET /api/butler-definitions — list defined butlers (always includes "default").
  router.get("/", async (c) => {
    const butlers = await listButlerDefinitions(database);
    return c.json({ butlers, max: MAX_BUTLERS });
  });

  // POST /api/butler-definitions — create a named butler { name, model?, provider? }.
  router.post("/", async (c) => {
    const body = await parseButlerDefinitionBody(c, createButlerDefinitionBody);
    const provider = body.provider === "codex" ? "codex" : body.provider === "claude" ? "claude" : undefined;
    const butler = await createButlerDefinition(database, { name: body.name ?? "", model: body.model, provider });
    return c.json({ butler }, 201);
  });

  // PUT /api/butler-definitions/:bid — update name, model, and/or provider.
  router.put("/:bid", async (c) => {
    // #806 batch 5 REJECTED this read, and corrected the reason batch 3 recorded for it: it is
    // family 5 (ORDER), not family 1 (coercion). `updateButlerDefinition` throws
    // `"Butler not found"` (404) BEFORE it reads `patch.name`, so a schema at the boundary
    // would answer 400 where a caller gets 404 today. `POST /` has no such lookup and
    // converted. (The note lives INSIDE the handler on purpose: `generate-openapi.ts` takes
    // the last comment line ABOVE a route as its summary.)
    const body = await parseJsonBody<{ name?: string; model?: string; provider?: string | null }>(c);
    const provider = body.provider === "codex" ? "codex" : body.provider === "claude" ? "claude" : body.provider === null ? null : undefined;
    const butler = await updateButlerDefinition(database, c.req.param("bid"), { name: body.name, model: body.model, provider });
    return c.json({ butler });
  });

  // DELETE /api/butler-definitions/:bid — remove a named butler ("default" is protected).
  router.delete("/:bid", async (c) => {
    await deleteButlerDefinition(database, c.req.param("bid"));
    return c.json({ ok: true });
  });

  return router;
}
