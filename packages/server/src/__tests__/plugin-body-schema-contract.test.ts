/**
 * #806 batch 2 — the plugin route bodies moved onto zod schemas, and this pins the three things
 * that swap could have broken invisibly.
 *
 * 1. **The `code` echo survives.** These guards threw `PluginError(msg, "BAD_REQUEST")`, which
 *    `domainErrorHandler` renders as `{ error, code: "BAD_REQUEST" }` (#823). A plain
 *    `parseJsonBody(c, schema)` throws `HTTPException`, whose body is `{ error }` alone — so the
 *    conversion would have silently dropped a machine-readable field from every rejection on this
 *    surface. `parsePluginBody` re-wraps; these tests are what proves it still does.
 * 2. **The messages are byte-identical** to the guards they replaced, including the two COMBINED
 *    messages ("gateId and actionId are required") that must not split into per-field ones.
 * 3. **`projectId` is still TRIMMED before the service sees it.** The old guards did
 *    `body.projectId.trim()` and passed the trimmed value on; `required` would have preserved the
 *    check and quietly changed the value, which is why `requiredTrimmed` exists.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "./helpers/test-db.js";
import { createPluginsRoute } from "../routes/plugins.js";
import {
  pluginGateResolveBody,
  pluginSaveArtifactBody,
  pluginScaffoldFillBody,
  pluginScaffoldSaveBody,
} from "../routes/plugin-body-schemas.js";

let app: Hono;

beforeEach(() => {
  const { db } = createTestDb();
  app = new Hono();
  app.route("/api/plugins", createPluginsRoute(db));
});

/** Raw text so an invalid-JSON case can be sent, which `JSON.stringify` cannot express. */
async function post(path: string, body: string) {
  const res = await app.request(`/api/plugins${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: res.status, body: (await res.json()) as { error?: string; code?: string } };
}

describe("plugin route bodies keep their error identity (#806)", () => {
  it("answers a missing projectId with the guard's exact 400 AND its BAD_REQUEST code", async () => {
    // Reaches the schema before any plugin lookup, so the unknown plugin id is irrelevant.
    const res = await post("/no-such-plugin/scaffold", JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("projectId is required");
    // The regression this test exists for: `HTTPException` would answer `{ error }` alone.
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("keeps the per-endpoint message rather than zod's default", async () => {
    const res = await post("/no-such-plugin/scaffold", JSON.stringify({ projectId: "p1" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("values must be an array");
    expect(res.body.code).toBe("BAD_REQUEST");
  });

  it("reports ONE combined message when the guard combined its fields", async () => {
    // The guard was `if (!gateId || !actionId)`, so a body missing only `actionId` was told about
    // both. Splitting that into a per-field message would change what the caller reads.
    const res = await post(
      "/no-such-plugin/loops/demo/gate/resolve",
      JSON.stringify({ projectId: "p1", gateId: "g1" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("gateId and actionId are required");
  });

  it("still answers 400 'invalid JSON body' for an unparseable body, now with the code", async () => {
    const res = await post("/no-such-plugin/scaffold", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid JSON body");
    // Declared change: this response previously carried no `code`. Status and message are
    // unchanged, and the request could never have succeeded.
    expect(res.body.code).toBe("BAD_REQUEST");
  });
});

describe("plugin body schemas preserve the guards' VALUES, not just their verdicts (#806)", () => {
  it("trims projectId the way the guard did, so the service receives the same string", () => {
    const parsed = pluginScaffoldFillBody.parse({ projectId: "  p1  ", values: [] });
    expect(parsed.projectId).toBe("p1");
  });

  it("trims gateId and path too", () => {
    const parsed = pluginSaveArtifactBody.parse({
      projectId: "p1",
      gateId: " g1 ",
      path: " docs/a.md ",
      content: "x",
    });
    expect(parsed.gateId).toBe("g1");
    expect(parsed.path).toBe("docs/a.md");
  });

  it("accepts an EMPTY `content`, which the `typeof !== 'string'` guard always did", () => {
    // `requiredTrimmed`/`requiredRaw` here would refuse to save an artifact empty — a live
    // request turned into a 400, which is exactly what these swaps may not do.
    expect(pluginSaveArtifactBody.parse({ projectId: "p", gateId: "g", path: "a", content: "" }).content).toBe("");
    expect(pluginScaffoldSaveBody.parse({ projectId: "p", content: "" }).content).toBe("");
  });

  it("passes unknown keys through, so a handler forwarding the whole body loses nothing", () => {
    const parsed = pluginScaffoldSaveBody.parse({ projectId: "p", content: "x", futureField: 1 }) as
      Record<string, unknown>;
    expect(parsed.futureField).toBe(1);
  });

  it("does NOT validate `values` elements — the handler filters them itself", () => {
    // A body with one malformed entry succeeds today with that entry dropped downstream.
    // `z.array(z.object({…}))` here would 400 it.
    const parsed = pluginScaffoldFillBody.parse({ projectId: "p", values: [{ index: "nope" }] });
    expect(parsed.values).toHaveLength(1);
  });

  it("leaves the coerced fields unchecked, so a wrong type is still coerced, not rejected", () => {
    // `input` was `typeof body.input === "string" ? body.input : undefined` — never a 400.
    expect(() =>
      pluginGateResolveBody.parse({ projectId: "p", gateId: "g", actionId: "a", input: 7 }),
    ).not.toThrow();
  });
});
