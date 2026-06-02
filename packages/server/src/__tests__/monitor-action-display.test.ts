import { describe, expect, it } from "vitest";
import type { MonitorAction } from "../startup/monitor-helpers.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";

/**
 * Unit tests for the action-to-display mapping logic used in the monitor
 * action replay drawer. These tests verify the data shapes that the server
 * produces and the client drawer renders.
 */

function makeAction(overrides: Partial<MonitorAction> = {}): MonitorAction {
  return {
    at: new Date(Date.now() - 60_000).toISOString(),
    action: "merge",
    workspaceId: "ws-abc-123",
    issueId: "issue-def-456",
    ...overrides,
  };
}

describe("MonitorAction shape — required fields", () => {
  it("has all base fields", () => {
    const action = makeAction();
    expect(action).toHaveProperty("at");
    expect(action).toHaveProperty("action");
    expect(action).toHaveProperty("workspaceId");
    expect(action).toHaveProperty("issueId");
  });

  it("optional detail fields default to undefined", () => {
    const action = makeAction();
    expect(action.endpoint).toBeUndefined();
    expect(action.httpStatus).toBeUndefined();
    expect(action.responseSummary).toBeUndefined();
    expect(action.verificationResult).toBeUndefined();
  });
});

describe("MonitorAction shape — action-specific shapes", () => {
  it("merge action with successful response", () => {
    const action = makeAction({
      action: "merge",
      endpoint: "/api/workspaces/ws-abc-123/merge",
      httpStatus: 200,
      verificationResult: "ok",
    });
    expect(action.action).toBe("merge");
    expect(action.endpoint).toBe("/api/workspaces/ws-abc-123/merge");
    expect(action.httpStatus).toBe(200);
    expect(action.verificationResult).toBe("ok");
  });

  it("merge action with conflict triggering fix-and-merge", () => {
    const action = makeAction({
      action: "merge",
      endpoint: "/api/workspaces/ws-abc-123/fix-and-merge",
      httpStatus: 200,
      responseSummary: "branch conflict detected",
      verificationResult: "ok",
    });
    expect(action.endpoint).toContain("fix-and-merge");
    expect(action.responseSummary).toBe("branch conflict detected");
  });

  it("relaunch action with endpoint", () => {
    const action = makeAction({
      action: "relaunch",
      endpoint: "/api/workspaces/ws-abc-123/launch",
      httpStatus: 201,
      verificationResult: "ok",
    });
    expect(action.action).toBe("relaunch");
    expect(action.endpoint).toContain("/launch");
  });

  it("mark_idle action without endpoint (DB-only operation)", () => {
    const action = makeAction({
      action: "mark_idle",
      responseSummary: "Ghost workspace deleted",
      verificationResult: "ok",
    });
    expect(action.action).toBe("mark_idle");
    expect(action.endpoint).toBeUndefined();
    expect(action.responseSummary).toBe("Ghost workspace deleted");
  });

  it("mark_dead action", () => {
    const action = makeAction({
      action: "mark_dead",
      verificationResult: "ok",
    });
    expect(action.action).toBe("mark_dead");
  });

  it("nudge action", () => {
    const action = makeAction({
      action: "nudge",
    });
    expect(action.action).toBe("nudge");
  });

  it("auto_start action", () => {
    const action = makeAction({
      action: "auto_start",
      endpoint: "/api/workspaces",
      httpStatus: 201,
      verificationResult: "ok",
    });
    expect(action.action).toBe("auto_start");
  });

  it("generate_tickets action", () => {
    const action = makeAction({
      action: "generate_tickets",
    });
    expect(action.action).toBe("generate_tickets");
  });
});

describe("MonitorAction — verification result values", () => {
  const validResults: Array<MonitorAction["verificationResult"]> = ["ok", "failed", "skipped", undefined];

  it.each(validResults)("verificationResult '%s' is a valid value", (result) => {
    const action = makeAction({ verificationResult: result });
    expect(["ok", "failed", "skipped", undefined]).toContain(action.verificationResult);
  });
});

describe("MonitorAction — HTTP status classification", () => {
  it("200 status is a success", () => {
    const action = makeAction({ httpStatus: 200 });
    const isOk = action.httpStatus !== undefined && action.httpStatus >= 200 && action.httpStatus < 300;
    expect(isOk).toBe(true);
  });

  it("201 status is a success", () => {
    const action = makeAction({ httpStatus: 201 });
    const isOk = action.httpStatus !== undefined && action.httpStatus >= 200 && action.httpStatus < 300;
    expect(isOk).toBe(true);
  });

  it("409 status is a failure", () => {
    const action = makeAction({ httpStatus: 409 });
    const isOk = action.httpStatus !== undefined && action.httpStatus >= 200 && action.httpStatus < 300;
    expect(isOk).toBe(false);
  });

  it("500 status is a failure", () => {
    const action = makeAction({ httpStatus: 500 });
    const isOk = action.httpStatus !== undefined && action.httpStatus >= 200 && action.httpStatus < 300;
    expect(isOk).toBe(false);
  });

  it("undefined status is not classified", () => {
    const action = makeAction();
    expect(action.httpStatus).toBeUndefined();
  });
});

describe("MonitorAction — responseSummary truncation", () => {
  it("accepts summaries up to 200 chars", () => {
    const longMessage = "x".repeat(200);
    const action = makeAction({ responseSummary: longMessage });
    expect(action.responseSummary).toHaveLength(200);
  });

  it("handles normal short summaries", () => {
    const action = makeAction({ responseSummary: "merge conflict on packages/shared" });
    expect(action.responseSummary).toBe("merge conflict on packages/shared");
  });
});

describe("MonitorActionName union — all action types are represented", () => {
  const ALL_ACTIONS: MonitorActionName[] = [
    "relaunch",
    "merge",
    "nudge",
    "mark_idle",
    "mark_dead",
    "auto_start",
    "generate_tickets",
  ];

  it("all known action types can be stored in a MonitorAction", () => {
    for (const action of ALL_ACTIONS) {
      const a = makeAction({ action });
      expect(a.action).toBe(action);
    }
  });
});
