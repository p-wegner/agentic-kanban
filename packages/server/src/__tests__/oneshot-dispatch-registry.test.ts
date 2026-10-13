import { describe, expect, it } from "vitest";
import { isOneShotDispatchLive, registerOneShotDispatch } from "../services/oneshot-dispatch-registry.js";
import { authorizeAssignment, createAssignmentLookup } from "../services/git-http.service.js";
import type { Database } from "../db/index.js";

describe("one-shot dispatches authorize their push (#1468)", () => {
  it("accepts a live one-shot branch past the settle window, and refuses it once the dispatch ends", async () => {
    const end = registerOneShotDispatch("w1", "p1", "kanban-oneshot/abc123def456");
    // A live registration answers before the DB is consulted, so a stub database is enough.
    const lookup = createAssignmentLookup({} as Database);
    const scope = { workerId: "w1", projectId: "p1", incomingRef: "refs/kanban/incoming/kanban-oneshot/abc123def456", issuedAtMs: 0 };
    const nowMs = 60 * 60_000;
    expect(await authorizeAssignment(scope, lookup, nowMs)).toEqual({ ok: true, reason: "assignment-current" });
    end();
    expect(isOneShotDispatchLive("w1", "p1", "kanban-oneshot/abc123def456")).toBe(false);
  });

  it("keys on the worker, so another worker's token for the same branch is not covered", () => {
    const end = registerOneShotDispatch("w1", "p1", "kanban-oneshot/x");
    expect(isOneShotDispatchLive("w2", "p1", "kanban-oneshot/x")).toBe(false);
    end();
  });
});
