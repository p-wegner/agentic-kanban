/**
 * #780 — proof that the client<->server wire boundary CHECKS instead of asserting.
 *
 * The acceptance case the ticket asks for is the first test here: a deliberately
 * mismatched response must produce an error AT THE BOUNDARY, naming the endpoint,
 * rather than a wrong-shaped object that fails later inside a component.
 *
 * This file imports `./api.js` directly, so dependency-based test selection picks it up
 * whenever the boundary changes — no `@gate:always-run` marker needed.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiFetch, apiFetchConditional, apiPost, apiPatch, ApiContractError } from "./api.js";
import { API_RESPONSE_SCHEMAS, findApiResponseSchema } from "./apiResponseSchemas.js";

function okJson(value: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
    headers: { get: (k: string) => headers[k] ?? null },
  } as unknown as Response;
}

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("the boundary rejects a mismatched response (#780 acceptance)", () => {
  it("throws ApiContractError when POST /api/issues returns the wrong type for a field", async () => {
    // The server contract says `title` is a string. Pretend it renamed/retyped it.
    fetchMock.mockResolvedValueOnce(
      okJson({ id: "i1", title: 42, projectId: "p1", statusId: "s1" }),
    );

    const error = await apiPost<{ id: string; title: string }>("/api/issues", { title: "x" }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiContractError);
    const contract = error as ApiContractError;
    expect(contract.method).toBe("POST");
    expect(contract.path).toBe("/api/issues");
    expect(contract.issues.join(" ")).toMatch(/title/);
    expect(contract.message).toMatch(/POST \/api\/issues/);
  });

  it("throws when a required field is MISSING, not just mistyped", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "i1", projectId: "p1", statusId: "s1" }));
    await expect(apiPost("/api/issues", {})).rejects.toBeInstanceOf(ApiContractError);
  });

  it("throws for a parameterised path too (PATCH /api/issues/:id)", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: null, title: "t", projectId: "p", statusId: "s" }));
    const error = await apiPatch("/api/issues/abc-123", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiContractError);
    expect((error as ApiContractError).path).toBe("/api/issues/abc-123");
  });

  it("throws when the response is not an object at all", async () => {
    fetchMock.mockResolvedValueOnce(okJson("just a string"));
    await expect(apiPost("/api/issues", {})).rejects.toBeInstanceOf(ApiContractError);
  });

  it("distinguishes a contract violation from an HTTP error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({ error: "boom" }),
    } as unknown as Response);
    const error = await apiPost("/api/issues", {}).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeInstanceOf(ApiContractError);
    expect((error as Error).message).toBe("boom");
  });
});

describe("a valid response passes through unharmed", () => {
  it("accepts a conforming body", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "i1", title: "t", projectId: "p", statusId: "s" }));
    const result = await apiPost<{ id: string }>("/api/issues", {});
    expect(result.id).toBe("i1");
  });

  it("PRESERVES fields the schema does not name (the validator is passthrough by construction)", async () => {
    // If this regresses, the validator silently deletes half of every response. That is a
    // worse failure than the cast it replaced, so it gets its own test.
    fetchMock.mockResolvedValueOnce(
      okJson({
        id: "i1",
        title: "t",
        projectId: "p",
        statusId: "s",
        issueNumber: 780,
        description: "kept",
        nested: { deep: [1, 2, 3] },
      }),
    );
    const result = await apiPost<Record<string, unknown>>("/api/issues", {});
    expect(result.issueNumber).toBe(780);
    expect(result.description).toBe("kept");
    expect(result.nested).toEqual({ deep: [1, 2, 3] });
  });

  it("accepts BOTH arms of the POST /api/workspaces union (201 workspace, 202 create-job)", async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({
        id: "w1",
        issueId: "i1",
        branch: "feature/ak-780",
        status: "running",
        workingDir: null,
        createdAt: "2026-08-23T00:00:00.000Z",
      }),
    );
    await expect(apiPost("/api/workspaces", {})).resolves.toMatchObject({ id: "w1" });

    fetchMock.mockResolvedValueOnce(
      okJson({ accepted: true, jobId: "j1", issueId: "i1", statusUrl: "/api/workspaces/create-jobs/j1" }),
    );
    await expect(apiPost("/api/workspaces", {})).resolves.toMatchObject({ jobId: "j1" });

    fetchMock.mockResolvedValueOnce(okJson({ accepted: true }));
    await expect(apiPost("/api/workspaces", {})).rejects.toBeInstanceOf(ApiContractError);
  });

  it("ignores the query string when matching a route", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "i1", title: 42, projectId: "p", statusId: "s" }));
    await expect(apiPost("/api/issues?projectId=p", {})).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe("the unvalidated path is explicit, not accidental", () => {
  it("returns an unregistered endpoint's body unchecked", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ anything: "goes" }));
    await expect(apiFetch("/api/not-a-registered-endpoint")).resolves.toEqual({ anything: "goes" });
  });

  it("a GET on a path only registered for POST is not validated by the POST schema", async () => {
    // Was `/api/issues` until #806 batch 2 registered the GET too — which is the healthy
    // outcome, not a broken test: this assertion needs a path the registry covers for ONE
    // verb, and every such example is a candidate for a later batch to fill in. `merge` is a
    // POST-only action, so it will not be claimed by a future read.
    expect(findApiResponseSchema("GET", "/api/tags/merge")).toBeUndefined();
    expect(findApiResponseSchema("POST", "/api/tags/merge")).toBeDefined();
  });

  it("prefers a literal segment over a :param at the same position", () => {
    // `/api/projects/create` and `/api/projects/:id` have the same shape; the literal wins.
    expect(findApiResponseSchema("POST", "/api/projects/create")).toBe(
      API_RESPONSE_SCHEMAS.find((r) => r.template === "/api/projects/create")?.schema,
    );
  });

  it("accepts a per-call schema for an endpoint the registry does not cover", async () => {
    // `ResponseSchema<T>` is structural (`{ parse(u): T }`), so a caller can bring any
    // parser — a zod schema, or a hand-written one like this.
    const countSchema = {
      parse(value: unknown) {
        if (typeof (value as { count?: unknown })?.count !== "number") {
          throw new Error("count must be a number");
        }
        return value as { count: number };
      },
    };

    fetchMock.mockResolvedValueOnce(okJson({ count: "not a number" }));
    await expect(apiFetch("/api/some/unregistered/thing", undefined, countSchema)).rejects.toThrow(
      /count must be a number/,
    );

    fetchMock.mockResolvedValueOnce(okJson({ count: 3 }));
    await expect(apiFetch("/api/some/unregistered/thing", undefined, countSchema)).resolves.toEqual({
      count: 3,
    });
  });

  it("a per-call schema WINS over the registry", async () => {
    // A body the registry would reject, accepted because the caller pinned its own shape.
    fetchMock.mockResolvedValueOnce(okJson({ whatever: true }));
    await expect(
      apiPost("/api/issues", {}, undefined, { parse: (v: unknown) => v as { whatever: boolean } }),
    ).resolves.toEqual({ whatever: true });
  });
});

describe("apiFetchConditional shares the same check", () => {
  it("validates a fresh body", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "w1" }, { ETag: "v1" }));
    await expect(
      apiFetchConditional("/api/workspaces/abc", null, { method: "GET" }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });

  it("still short-circuits a 304 without touching the schema", async () => {
    fetchMock.mockResolvedValueOnce({ status: 304, ok: false } as unknown as Response);
    await expect(apiFetchConditional("/api/workspaces/abc", "v1", { method: "GET" })).resolves.toEqual({
      kind: "not-modified",
    });
  });
});

describe("the assertions the ticket names are gone", () => {
  it("api.ts contains no `res.json() as T` / `as Promise<T>` cast", () => {
    const source = readFileSync(fileURLToPath(new URL("./api.ts", import.meta.url)), "utf8");
    // Comments quote the old form on purpose (they explain what was removed), so strip them.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/res\.json\(\)\s*\)?\s*as\s/);
    expect(code).not.toMatch(/as\s+Promise<T>/);
  });
});
