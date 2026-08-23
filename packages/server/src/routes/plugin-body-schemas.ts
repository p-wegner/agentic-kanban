/**
 * Request-body schemas for the write routes on `/api/plugins` (#806, batch 2).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving. Two things are specific to THIS route file and were the reason batch 1
 * left it alone:
 *
 * 1. **These guards throw `PluginError(msg, "BAD_REQUEST")`, not `c.json({error}, 400)`.**
 *    `domainErrorHandler` renders that as `{ error, code: "BAD_REQUEST" }` (#823) while an
 *    `HTTPException` renders as `{ error }` alone — so a bare `parseJsonBody(c, schema)` swap
 *    would DROP the machine-readable `code` from every rejection. `parsePluginBody` in
 *    `plugins.ts` re-throws the schema's `HTTPException` as a `PluginError`, which restores it;
 *    the schemas below therefore carry the guards' exact messages and nothing else changes.
 * 2. **`projectId` is trimmed before it is checked AND before it is used**
 *    (`typeof body.projectId === "string" ? body.projectId.trim() : ""`), so these fields use
 *    `requiredTrimmed`, which reproduces both halves. `required` would preserve the check and
 *    silently start handing the service the untrimmed value.
 *
 * The ratchet's own header claimed many of these guards read
 * `body.projectId ?? c.req.query("projectId")` — "optional in the body, required overall", which
 * no body schema could express. That is **not true of this file**: every POST/PUT handler here
 * requires `projectId` in the BODY, and the query-param fallback exists only on the GET routes,
 * which read no body at all. The corrected note lives in the ratchet test.
 *
 * `POST /api/plugins` and `POST /api/plugins/validate` stay unconverted on purpose — see the
 * ratchet test for why (their `source` handling is a coercion, not a check).
 */
import { z } from "zod";
import { arrayOnly, requiredTrimmed, stringOnly, unchecked } from "./body-schema-helpers.js";

/** The shared opening field of every body below, in the position its guard ran: first. */
const projectId = requiredTrimmed("projectId is required");

/**
 * `POST /api/plugins/:id/output-location`.
 *
 * `location` keeps NO predicate: the handler coerces a non-string to `""` and lets
 * `setOutputLocation` decide, so a type check here would 400 a body the endpoint accepts.
 */
export const pluginOutputLocationBody = z.object({
  projectId,
  location: unchecked<string>(),
}).passthrough();

/**
 * `POST /api/plugins/:id/loops/:name/gate/resolve`.
 *
 * `gateId` and `actionId` share ONE message because the guard was a single
 * `if (!gateId || !actionId)` — splitting it would change what a caller missing only `actionId`
 * is told. `input` is coerced, not checked, so it carries its declared type only.
 */
export const pluginGateResolveBody = z.object({
  projectId,
  gateId: requiredTrimmed("gateId and actionId are required"),
  actionId: requiredTrimmed("gateId and actionId are required"),
  input: unchecked<string>(),
}).passthrough();

/**
 * `PUT /api/plugins/:id/loops/:name/artifact`.
 *
 * `content` is `typeof === "string"` and NOT non-blank: the guard was
 * `typeof body.content !== "string"`, which accepts `""` — saving an artifact empty is a
 * legitimate edit, and `requiredTrimmed` would start refusing it.
 */
export const pluginSaveArtifactBody = z.object({
  projectId,
  gateId: requiredTrimmed("gateId, path and content are required"),
  path: requiredTrimmed("gateId, path and content are required"),
  content: stringOnly("gateId, path and content are required"),
}).passthrough();

/** `POST /api/plugins/:id/loops/:name/gate/draft`. `notes` is coerced to `""`, not checked. */
export const pluginGateDraftBody = z.object({
  projectId,
  gateId: requiredTrimmed("gateId is required"),
  notes: unchecked<string>(),
}).passthrough();

/** `POST /api/plugins/:id/loops/:name/gate/summarize`. */
export const pluginGateSummarizeBody = z.object({
  projectId,
  gateId: requiredTrimmed("gateId is required"),
}).passthrough();

/**
 * `POST /api/plugins/:id/scaffold`.
 *
 * `arrayOnly`, never `z.array(z.object({…}))`: the handler FILTERS the entries itself
 * (`typeof v?.index === "number" && typeof v?.value === "string"`), so a body with one malformed
 * entry succeeds today with that entry dropped. Validating the elements here would 400 it.
 */
export const pluginScaffoldFillBody = z.object({
  projectId,
  values: arrayOnly<{ index?: number; value?: string }>("values must be an array"),
}).passthrough();

/** `PUT /api/plugins/:id/scaffold` — whole-file overwrite; `""` is a legal (emptying) write. */
export const pluginScaffoldSaveBody = z.object({
  projectId,
  content: stringOnly("content must be a string"),
}).passthrough();
