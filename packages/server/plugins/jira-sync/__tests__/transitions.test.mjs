import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTransitionId, TransitionNotFoundError } from "../tools/lib/transitions.mjs";
import { loadFixture } from "../tools/lib/fixtures.mjs";

const TRANSITIONS = loadFixture("transitions").transitions;

test("resolveTransitionId: finds the transition whose destination matches the target status", () => {
  assert.equal(resolveTransitionId(TRANSITIONS, "In Progress"), "11");
  assert.equal(resolveTransitionId(TRANSITIONS, "Done"), "21");
});

test("resolveTransitionId: throws TransitionNotFoundError for an unreachable status, never a hardcoded fallback", () => {
  assert.throws(
    () => resolveTransitionId(TRANSITIONS, "Cancelled"),
    (err) => {
      assert.ok(err instanceof TransitionNotFoundError);
      assert.equal(err.targetStatus, "Cancelled");
      assert.deepEqual(err.available, ["In Progress", "Done"]);
      return true;
    },
  );
});

test("resolveTransitionId: reports 'none' when the issue has no transitions at all", () => {
  assert.throws(() => resolveTransitionId([], "Done"), /available: none/);
});
