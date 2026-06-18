import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { apiPost, apiPut, apiPatch, apiDelete } from "./api.js";

function okJson(value: unknown) {
  return { ok: true, json: () => Promise.resolve(value) } as unknown as Response;
}

describe("api verb helpers", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okJson({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("apiPost sends method POST with a JSON-stringified body", async () => {
    await apiPost("/api/x", { a: 1 });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/x");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("omits the body entirely for a bodyless call", async () => {
    await apiPost("/api/run");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect("body" in init).toBe(false);
  });

  it.each([
    ["apiPut", apiPut, "PUT"],
    ["apiPatch", apiPatch, "PATCH"],
    ["apiDelete", apiDelete, "DELETE"],
  ] as const)("%s sends method %s", async (_label, fn, method) => {
    await fn("/api/y", { v: 2 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe(method);
    expect(init.body).toBe(JSON.stringify({ v: 2 }));
  });

  it("threads extra RequestInit (e.g. signal) through", async () => {
    const controller = new AbortController();
    await apiPost("/api/z", { a: 1 }, { signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
    expect(init.method).toBe("POST");
  });

  it("returns the parsed JSON response", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: "abc" }));
    const result = await apiPost<{ id: string }>("/api/x", {});
    expect(result.id).toBe("abc");
  });
});
