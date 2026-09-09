import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraApiError, normalizeHttpError, normalizeNetworkError } from "../tools/lib/errors.mjs";

test("normalizeHttpError: maps status codes to a stable code", () => {
  const cases = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [418, "unknown"],
  ];
  for (const [status, code] of cases) {
    const err = normalizeHttpError({ status, statusText: "x", body: null });
    assert.equal(err.code, code, `status ${status}`);
  }
});

test("normalizeHttpError: 429 and 5xx are retryable, everything else is not", () => {
  assert.equal(normalizeHttpError({ status: 429, statusText: "", body: null }).retryable, true);
  assert.equal(normalizeHttpError({ status: 503, statusText: "", body: null }).retryable, true);
  assert.equal(normalizeHttpError({ status: 400, statusText: "", body: null }).retryable, false);
  assert.equal(normalizeHttpError({ status: 404, statusText: "", body: null }).retryable, false);
});

test("normalizeHttpError: joins errorMessages[] into the message", () => {
  const err = normalizeHttpError({ status: 400, statusText: "Bad Request", body: { errorMessages: ["A", "B"] } });
  assert.equal(err.message, "A; B");
});

test("normalizeHttpError: flattens errors{field: message} into the message", () => {
  const err = normalizeHttpError({ status: 400, statusText: "Bad Request", body: { errors: { summary: "is required" } } });
  assert.equal(err.message, "summary: is required");
});

test("normalizeHttpError: falls back to statusText when the body has no messages", () => {
  const err = normalizeHttpError({ status: 500, statusText: "Internal Server Error", body: null });
  assert.equal(err.message, "Internal Server Error");
});

test("normalizeHttpError: falls back to a plain string body", () => {
  const err = normalizeHttpError({ status: 502, statusText: "Bad Gateway", body: "upstream connect error" });
  assert.equal(err.message, "upstream connect error");
});

test("JiraApiError instances are real Errors and JSON-serialize their code/status", () => {
  const err = normalizeHttpError({ status: 404, statusText: "Not Found", body: null });
  assert.ok(err instanceof JiraApiError);
  assert.ok(err instanceof Error);
  const json = err.toJSON();
  assert.equal(json.status, 404);
  assert.equal(json.code, "not_found");
});

test("normalizeNetworkError: always retryable, carries the cause", () => {
  const cause = new Error("ECONNREFUSED");
  const err = normalizeNetworkError(cause);
  assert.equal(err.retryable, true);
  assert.equal(err.code, "network_error");
  assert.equal(err.cause, cause);
});
