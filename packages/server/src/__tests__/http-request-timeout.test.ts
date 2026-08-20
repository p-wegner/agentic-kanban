// @gate:always-run — asserts against server-start.ts SOURCE, which its imports never reach (#687).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "../services/verify-budget.js";

/**
 * The HTTP layer must not cut off an operation the board itself budgets minutes for (#680).
 *
 * Node's default `requestTimeout` is 5 minutes. Measured twice: `POST /api/workspaces/:id/merge`
 * came back as `HTTP 000` (socket closed) after ~5 minutes while the gate kept running
 * server-side, so the caller could never learn the outcome of a merge whose verify budget is 45
 * minutes. Every long endpoint shares the shape — merge, review, fix-and-merge.
 *
 * Asserted against the SOURCE rather than by booting a server and waiting: the property is
 * "the ceiling is derived from the verify budget", and a test that proved it by elapsing real
 * time would itself take 5 minutes and be the very kind of load-dependent gate #680 removed.
 */
describe("HTTP request timeout (#680)", () => {
  const source = readFileSync(join(import.meta.dirname!, "..", "server-start.ts"), "utf8");

  it("sets requestTimeout AND headersTimeout explicitly", () => {
    // headersTimeout below requestTimeout silently becomes the effective ceiling.
    expect(source).toMatch(/requestTimeout\s*=\s*HTTP_REQUEST_TIMEOUT_MS/);
    expect(source).toMatch(/headersTimeout\s*=\s*HTTP_REQUEST_TIMEOUT_MS/);
  });

  it("derives the ceiling from the verify budget, so the two cannot drift apart", () => {
    expect(source).toMatch(/HTTP_REQUEST_TIMEOUT_MS\s*=\s*VERIFY_SCRIPT_TIMEOUT_MS\s*\+/);
    // And the budget it derives from is itself longer than Node's 5-minute default, which is
    // the whole point — a derived value that happened to be smaller would fix nothing.
    expect(VERIFY_SCRIPT_TIMEOUT_MS).toBeGreaterThan(5 * 60 * 1000);
  });
});
