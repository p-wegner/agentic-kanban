// #1407 — a session the board already ended or superseded must not write the incoming ref
// of its successor, and a remote assignment always carries the ticket brief.
import { describe, it, expect } from "vitest";
import { authorizeAssignment } from "../services/git-http.service.js";
import { withTicketContextFile } from "../services/remote-context-files.js";

const now = Date.now();
const scope = {
  workerId: "w1",
  projectId: "p1",
  incomingRef: "refs/kanban/incoming/feature/ak-1",
  sessionId: "old",
  issuedAtMs: now - 60_000, // inside the settle window, which must NOT excuse a stale session
};
const current = async () => true;

describe("authorizeAssignment with a superseded session (#1407)", () => {
  it("refuses a superseded session even inside the settle window", async () => {
    const out = await authorizeAssignment(scope, current, now, async () => true);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no longer the current session");
  });

  it("allows the current session", async () => {
    const out = await authorizeAssignment(scope, current, now, async () => false);
    expect(out.ok).toBe(true);
  });

  it("fails closed when the supersession lookup throws", async () => {
    const out = await authorizeAssignment(scope, current, now, async () => { throw new Error("db"); });
    expect(out.ok).toBe(false);
  });

  it("a token without a session id keeps the assignment-only behaviour", async () => {
    const out = await authorizeAssignment({ ...scope, sessionId: undefined }, current, now, async () => true);
    expect(out.ok).toBe(true);
  });
});

describe("withTicketContextFile (#1407)", () => {
  it("adds the worktree's CLAUDE.local.md when the launch passed no context files", () => {
    const out = withTicketContextFile(undefined, "/wt", () => true);
    expect(out).toHaveLength(1);
    expect(out![0]).toContain("CLAUDE.local.md");
  });

  it("does not duplicate a ticket context file the caller already passed", () => {
    const given = ["/wt/CLAUDE.local.md"];
    expect(withTicketContextFile(given, "/wt", () => true)).toBe(given);
  });

  it("leaves the list alone when the worktree has no brief", () => {
    expect(withTicketContextFile(undefined, "/wt", () => false)).toBeUndefined();
  });
});
