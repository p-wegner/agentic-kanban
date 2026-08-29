// @gate:always-run
//
// #838 — the FOURTH half of the openapi gate. `openapi-drift.test.ts` proves the committed
// spec matches what the generator produces, `openapi-route-coverage.test.ts` proves the
// generator looks at every route, `openapi-thrown-status.test.ts` proves it sees the statuses
// the error middleware decides. This suite is about the REQUEST side, and it exists because
// nothing failed while that side quietly got worse.
//
// The generator read a body's shape from the `parseJsonBody<T>(c)` type argument. #806 is
// converting those to `parseJsonBody(c, zodSchema)` — runtime validation, no type argument —
// so every converted route fell through to the generator's "unknown shape" branch and the spec
// described it as `additionalProperties: true` with NO property list: "any object", for an
// endpoint that rejects most objects. The count CLIMBED with each batch (95 before batch 3,
// 118 after) and not one check went red, which is exactly how it got there. #838 taught the
// generator to read the zod schema, taking it 118 -> 57.
//
// This is the shrink-only ratchet on what is left. Both halves matter:
//   - a NEW operation with no property list fails (assertion 1), so the next conversion batch
//     cannot re-grow the number;
//   - an entry that HAS since gained one fails too (assertion 2), so the list shrinks by
//     DELETION rather than rotting into a budget that no longer describes the spec. That is
//     the staleness half `status-write-ratchet.test.ts` and `workspaces-table-width-ratchet.
//     test.ts` grew for the same reason (#483/#830).
//
// It reads the committed `openapi.yaml`, which is not in this file's import graph — hence the
// marker.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

const SPEC = join(resolve(import.meta.dirname, "../../../.."), "packages/server/openapi.yaml");

type Operation = { requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } } };
type Spec = { paths: Record<string, Record<string, Operation>> };

/**
 * `<METHOD> <path>` for every operation that accepts a request body the spec cannot describe
 * beyond "an object". This is the number the ratchet governs; it is deliberately keyed on the
 * PRESENCE of `properties` rather than on `additionalProperties`, because a read schema keeps
 * `additionalProperties: true` too (zod accepts unknown keys either way — see `x-unknown-keys`).
 */
export function operationsWithoutPropertyList(spec: Spec): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const schema = op.requestBody?.content["application/json"].schema;
      if (schema && !("properties" in schema)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out.sort();
}

/**
 * The operations whose request body is still shape-less, frozen. Every one of them DOES parse a
 * body — either with no schema (`parseJsonBody(c)` / `parseOptionalJsonBody(c)`) or through a
 * raw `c.req.json()` / `formData()` / `text()` the generator can see but cannot shape. So this
 * list IS #806's remaining surface, and it is the work list, not an exemption. Delete an entry
 * when its route gains a schema; never add one.
 *
 * #935 took it 57 -> 24 by DELETION, not by exemption. The 33 that left were body-LESS POSTs
 * (`/archive`, `/stop`, `/close`, …) which the generator used to hand a fallback
 * `additionalProperties: true` body simply because they were not GET or DELETE. They could
 * never have been resolved the way this list intends — there is no schema for a body that does
 * not exist — so they sat here permanently, diluting the count. The generator now emits no
 * `requestBody` for them at all, and what remains is 24 routes that really do take one.
 */
const NO_PROPERTY_LIST: string[] = [
  "PATCH /api/issues/{id}",
  "PATCH /api/projects/{id}",
  "PATCH /api/projects/{projectId}/scripts/{scriptId}",
  "PATCH /api/workspaces/{id}",
  "POST /api/plugins",
  "POST /api/plugins/validate",
  "POST /api/projects/{id}/conductor",
  "POST /api/projects/{id}/onboarding/dismiss",
  "POST /api/projects/{id}/quality-metrics",
  "POST /api/projects/{projectId}/backlog.md/import",
  "POST /api/projects/{projectId}/backlog.md/preview",
  "POST /api/projects/{projectId}/backlog/import",
  "POST /api/projects/{projectId}/config/import",
  "POST /api/projects/{projectId}/issues/import",
  "POST /api/projects/{projectId}/issues/import/preview",
  "POST /api/projects/{projectId}/scripts",
  "POST /api/workflows/workspaces/{id}/transition",
  "POST /api/workspaces/{id}/launch",
  "POST /api/workspaces/{id}/update-base",
  "PUT /api/preferences/settings",
  "PUT /api/projects/{id}/conductor-schedule",
  "PUT /api/projects/{id}/stack-profile",
  "PUT /api/projects/{projectId}/drives/{id}",
  "PUT /api/scheduled-runs/{id}",
];

function loadSpec(): Spec {
  return YAML.parse(readFileSync(SPEC, "utf8")) as Spec;
}

describe("openapi request-body property lists (#838)", () => {
  it("no operation loses — or newly lacks — a request-body property list", () => {
    const actual = operationsWithoutPropertyList(loadSpec());
    const added = actual.filter((op) => !NO_PROPERTY_LIST.includes(op));
    expect(
      added,
      "these operations describe their request body as `additionalProperties: true` with no "
      + "property list, and are not on the frozen list. Either the route stopped validating its "
      + "body, or the generator can no longer read the zod schema it passes to `parseJsonBody` "
      + "(run `pnpm openapi:generate` — it names every schema it could not read).",
    ).toEqual([]);
  });

  it("the frozen list holds no stale entry", () => {
    // The half that stops the list becoming a budget: an operation that has GAINED a property
    // list must be deleted from `NO_PROPERTY_LIST`, not left sitting there reading as an
    // endpoint that still has no schema. An entry naming an operation that no longer exists
    // fails the same way, for the same reason.
    const spec = loadSpec();
    const actual = new Set(operationsWithoutPropertyList(spec));
    const allOperations = new Set(
      Object.entries(spec.paths).flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`)),
    );
    const gained = NO_PROPERTY_LIST.filter((op) => allOperations.has(op) && !actual.has(op));
    expect(gained, "these operations now document their body — delete them from NO_PROPERTY_LIST").toEqual([]);
    const gone = NO_PROPERTY_LIST.filter((op) => !allOperations.has(op));
    expect(gone, "these operations no longer exist — delete them from NO_PROPERTY_LIST").toEqual([]);
  });

  it("a converted route documents what its zod schema actually enforces", () => {
    // The positive half. Without it the ratchet is satisfiable by a generator that reads
    // nothing at all and a list that has grown to cover every operation. `POST /api/issues`
    // is `createIssueBody`: two required fields with the guards' own order, ten optional ones
    // carrying the declared type the route never checked, and `.passthrough()`.
    const spec = loadSpec();
    const schema = spec.paths["/api/issues"]!.post!.requestBody!.content["application/json"].schema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
      "x-unknown-keys": string;
    };
    expect(schema.required).toEqual(["projectId", "title"]);
    expect(schema.properties.title).toEqual({ type: "string" });
    expect(schema.properties.skipAutoReview).toEqual({ type: "boolean" });
    expect(schema.properties.reposTouched).toEqual({ type: "array", items: { type: "string" } });
    // `externalKey: unchecked<string | null>()` — optional, and nullable rather than absent.
    expect(schema.properties.externalKey).toEqual({ type: "string", nullable: true });
    // `.passthrough()`: unknown keys reach the handler. A bare `z.object()` would say
    // `stripped` — the one decision the TS type argument could never carry.
    expect(schema["x-unknown-keys"]).toBe("passthrough");
    expect(schema.additionalProperties).toBe(true);
  });

  it("a route that reads its body RAW still documents one (#935)", () => {
    // The guard on #935's omission rule. Omitting `requestBody` when no body is parsed is only
    // correct while a RAW read (`c.req.json()` / `formData()` / `text()`) counts as parsing —
    // those routes carry no `parseJsonBody` call, so a generator that keyed off that alone would
    // report "no body" for endpoints whose body is mandatory. These six are the ones that
    // actually bit: multi-encoding import/preview handlers, one of them (`backlog.md/*`) reading
    // through a same-file helper. If this fails, the spec is telling a caller that an endpoint
    // needing `{text: …}` takes nothing.
    const spec = loadSpec();
    const rawBodyRoutes = [
      ["post", "/api/projects/{projectId}/backlog.md/import"],
      ["post", "/api/projects/{projectId}/backlog.md/preview"],
      ["post", "/api/projects/{projectId}/backlog/import"],
      ["post", "/api/projects/{projectId}/config/import"],
      ["post", "/api/projects/{projectId}/issues/import"],
      ["post", "/api/projects/{projectId}/issues/import/preview"],
    ] as const;
    for (const [method, path] of rawBodyRoutes) {
      expect(spec.paths[path]?.[method]?.requestBody, `${method.toUpperCase()} ${path} reads its body with a raw accessor — it must still document one`).toBeDefined();
    }
  });

  it("a route that reads NO body documents none (#935)", () => {
    // The other half. A body-less POST used to be handed `additionalProperties: true` with
    // `required: false` purely because it was not GET/DELETE — "you may post any object", about
    // a handler that never looks at one. `/reprobe` is #935's own route and takes only a path
    // param; the rest are long-standing action POSTs.
    const spec = loadSpec();
    const bodylessRoutes = [
      ["post", "/api/projects/{id}/base-branch-health/reprobe"],
      ["post", "/api/projects/{id}/archive"],
      ["post", "/api/workspaces/{id}/stop"],
      ["post", "/api/workspaces/{id}/close"],
    ] as const;
    for (const [method, path] of bodylessRoutes) {
      expect(spec.paths[path]?.[method], `${method.toUpperCase()} ${path} must exist in the spec`).toBeDefined();
      expect(spec.paths[path]?.[method]?.requestBody, `${method.toUpperCase()} ${path} parses no body — it must not claim to accept one`).toBeUndefined();
    }
  });

  it("bites in BOTH directions", () => {
    // A negative control on the comparison itself, run against a doctored copy of the spec in
    // memory — proving a gate bites must never require mutating a tracked file in this shared
    // checkout (#814).
    const spec = loadSpec();
    const doctored = YAML.parse(readFileSync(SPEC, "utf8")) as Spec;

    // Direction 1 — an operation LOSES its property list (a conversion the generator cannot
    // read, or a route that stopped validating). It must appear as an addition.
    const issuesPost = doctored.paths["/api/issues"]!.post!.requestBody!.content["application/json"];
    issuesPost.schema = { type: "object", additionalProperties: true };
    const added = operationsWithoutPropertyList(doctored).filter((op) => !NO_PROPERTY_LIST.includes(op));
    expect(added).toEqual(["POST /api/issues"]);

    // Direction 2 — a frozen entry GAINS one and the list is not updated. It must appear as
    // stale, which is what keeps the list shrinking by deletion.
    const listed = NO_PROPERTY_LIST[0]!;
    const [method, path] = [listed.slice(0, listed.indexOf(" ")).toLowerCase(), listed.slice(listed.indexOf(" ") + 1)];
    doctored.paths[path]![method]!.requestBody!.content["application/json"].schema = {
      type: "object",
      properties: { anything: { type: "string" } },
    };
    const actual = new Set(operationsWithoutPropertyList(doctored));
    expect(NO_PROPERTY_LIST.filter((op) => !actual.has(op))).toEqual([listed]);

    // …and the undoctored spec is clean on both, which is the assertion the two `it`s above make.
    expect(operationsWithoutPropertyList(spec)).toEqual([...NO_PROPERTY_LIST].sort());
  });
});
