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

const GERMAN = loadFixture("transitions-de").transitions;

test("resolveTransitionId: resolves board statuses against German status names by category (#1623)", () => {
  assert.equal(resolveTransitionId(GERMAN, "Todo"), "11");
  assert.equal(resolveTransitionId(GERMAN, "Backlog"), "11");
  assert.equal(resolveTransitionId(GERMAN, "In Progress"), "21");
  assert.equal(resolveTransitionId(GERMAN, "In Review"), "21");
  assert.equal(resolveTransitionId(GERMAN, "Done"), "31");
});

test("resolveTransitionId: an explicit override beats category matching", () => {
  assert.equal(resolveTransitionId(GERMAN, "Done", { overrides: { Done: "In Arbeit" } }), "21");
  assert.throws(() => resolveTransitionId(GERMAN, "Done", { overrides: { Done: "Nope" } }), TransitionNotFoundError);
});

test("resolveTransitionId: an ambiguous category fails and lists the candidates", () => {
  const two = [
    { id: "1", name: "a", to: { name: "Doing", statusCategory: { key: "indeterminate" } } },
    { id: "2", name: "b", to: { name: "Review", statusCategory: { key: "indeterminate" } } },
  ];
  assert.throws(
    () => resolveTransitionId(two, "In Progress"),
    (err) => err instanceof TransitionNotFoundError && /ambiguous/.test(err.message) && err.available.join() === "Doing,Review",
  );
});
