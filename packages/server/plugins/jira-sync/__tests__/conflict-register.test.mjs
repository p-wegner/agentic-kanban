import { test } from "node:test";
import assert from "node:assert/strict";
import { updateRegister, outstandingEntries, pushFailureIdentity } from "../tools/lib/conflict-register.mjs";

test("updateRegister: a fresh identity starts at round 1, unresolved", () => {
  const next = updateRegister({ entries: {} }, [{ id: "ENG-1", reason: "edited locally" }], { now: "2026-01-01T00:00:00.000Z" });
  assert.deepEqual(next.entries["ENG-1"], {
    round: 1,
    resolved: false,
    detectedAt: "2026-01-01T00:00:00.000Z",
    reason: "edited locally",
  });
});

test("updateRegister: an identity still current on the next run keeps its round", () => {
  const first = updateRegister({ entries: {} }, [{ id: "ENG-1", reason: "edited locally" }], { now: "2026-01-01T00:00:00.000Z" });
  const second = updateRegister(first, [{ id: "ENG-1", reason: "still edited locally" }], { now: "2026-01-02T00:00:00.000Z" });
  assert.equal(second.entries["ENG-1"].round, 1);
  assert.equal(second.entries["ENG-1"].resolved, false);
  assert.equal(second.entries["ENG-1"].detectedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(second.entries["ENG-1"].reason, "still edited locally");
});

test("updateRegister: an identity absent from the current run is marked resolved", () => {
  const first = updateRegister({ entries: {} }, [{ id: "ENG-1" }], { now: "2026-01-01T00:00:00.000Z" });
  const second = updateRegister(first, [], { now: "2026-01-02T00:00:00.000Z" });
  assert.equal(second.entries["ENG-1"].resolved, true);
  assert.equal(second.entries["ENG-1"].resolvedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(second.entries["ENG-1"].round, 1);
});

test("updateRegister: an identity recurring after being resolved gets a fresh round", () => {
  const round1 = updateRegister({ entries: {} }, [{ id: "ENG-1" }], { now: "2026-01-01T00:00:00.000Z" });
  const resolved = updateRegister(round1, [], { now: "2026-01-02T00:00:00.000Z" });
  const round2 = updateRegister(resolved, [{ id: "ENG-1", reason: "conflicted again" }], { now: "2026-01-03T00:00:00.000Z" });
  assert.equal(round2.entries["ENG-1"].round, 2);
  assert.equal(round2.entries["ENG-1"].resolved, false);
  assert.equal(round2.entries["ENG-1"].detectedAt, "2026-01-03T00:00:00.000Z");
});

test("outstandingEntries: only unresolved entries, resolved ones excluded", () => {
  const register = {
    entries: {
      "ENG-1": { round: 1, resolved: false, detectedAt: "t1", reason: "r1" },
      "ENG-2": { round: 1, resolved: true, detectedAt: "t2", resolvedAt: "t3" },
    },
  };
  assert.deepEqual(outstandingEntries(register), [{ id: "ENG-1", round: 1, reason: "r1", detectedAt: "t1" }]);
});

test("pushFailureIdentity: prefers the Jira key, falls back to a board-issue-id identity", () => {
  assert.equal(pushFailureIdentity({ key: "ENG-1", boardIssueId: "b1" }), "ENG-1");
  assert.equal(pushFailureIdentity({ boardIssueId: "b1" }), "board:b1");
});
