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
 * The operations whose request body is still shape-less, frozen. Every one of them parses its
 * body with no schema (`parseJsonBody(c)` / `parseOptionalJsonBody(c)`) or does not parse one
 * at all — i.e. this list IS #806's remaining surface, and it is the work list, not an
 * exemption. Delete an entry when its route gains a schema; never add one.
 */
const NO_PROPERTY_LIST: string[] = [
  "POST /api/internal/monitor-run",
  "POST /api/internal/resource-sweep",
  "PATCH /api/issues/{id}",
  "POST /api/issues/{id}/duplicate",
  "POST /api/merge-queue/preview/{workspaceId}",
  "POST /api/plugins",
  "POST /api/plugins/validate",
  "POST /api/plugins/{id}/update",
  "POST /api/preferences/mcp/probe",
  "PUT /api/preferences/settings",
  "PATCH /api/projects/{id}",
  "POST /api/projects/{id}/agent-questions/{toolUseId}/recommend",
  "POST /api/projects/{id}/archive",
  "POST /api/projects/{id}/butler/ensure",
  "POST /api/projects/{id}/butler/interrupt",
  "POST /api/projects/{id}/conductor",
  "PUT /api/projects/{id}/conductor-schedule",
  "POST /api/projects/{id}/dependency-waves/start-next",
  "POST /api/projects/{id}/onboarding/dismiss",
  "POST /api/projects/{id}/quality-metrics",
  "POST /api/projects/{id}/repos/{repoId}/promote",
  "PUT /api/projects/{id}/stack-profile",
  "POST /api/projects/{id}/unarchive",
  "POST /api/projects/{projectId}/backlog.md/import",
  "POST /api/projects/{projectId}/backlog.md/preview",
  "POST /api/projects/{projectId}/backlog/import",
  "POST /api/projects/{projectId}/config/import",
  "PUT /api/projects/{projectId}/drives/{id}",
  "POST /api/projects/{projectId}/issues/import",
  "POST /api/projects/{projectId}/issues/import/preview",
  "POST /api/projects/{projectId}/scripts",
  "PATCH /api/projects/{projectId}/scripts/{scriptId}",
  "POST /api/projects/{projectId}/scripts/{scriptId}/run",
  "PUT /api/scheduled-runs/{id}",
  "POST /api/scheduled-runs/{id}/run",
  "POST /api/workers/pairing-token",
  "POST /api/workflows/workspaces/{id}/transition",
  "PATCH /api/workspaces/{id}",
  "POST /api/workspaces/{id}/abort-rebase",
  "POST /api/workspaces/{id}/close",
  "POST /api/workspaces/{id}/github-handoff-draft",
  "POST /api/workspaces/{id}/launch",
  "POST /api/workspaces/{id}/merge",
  "POST /api/workspaces/{id}/open-editor",
  "POST /api/workspaces/{id}/quarantine",
  "POST /api/workspaces/{id}/ready-for-merge",
  "POST /api/workspaces/{id}/repos/{repoName}/rebase",
  "POST /api/workspaces/{id}/resolve-conflicts",
  "POST /api/workspaces/{id}/retry-cleanup",
  "POST /api/workspaces/{id}/scorecard/refresh",
  "POST /api/workspaces/{id}/services/down",
  "POST /api/workspaces/{id}/services/restart",
  "POST /api/workspaces/{id}/services/up",
  "POST /api/workspaces/{id}/setup",
  "POST /api/workspaces/{id}/stop",
  "POST /api/workspaces/{id}/terminal",
  "POST /api/workspaces/{id}/update-base",
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
