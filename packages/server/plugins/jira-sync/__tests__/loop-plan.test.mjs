import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLoopPlan } from "../tools/lib/loop-plan.mjs";
import { updateRegister } from "../tools/lib/conflict-register.mjs";

const CURSOR = { lastPullAt: "2026-01-01T00:00:00.000Z", lastPushAt: null };
const EMPTY_REGISTER = { entries: {} };

test("blocked round: no successful pull yet reports converged: false with no units", () => {
  const plan = buildLoopPlan({
    cursor: { lastPullAt: null, lastPushAt: null },
    conflictRegister: EMPTY_REGISTER,
    failureRegister: EMPTY_REGISTER,
  });
  assert.deepEqual(plan.units, []);
  assert.equal(plan.converged, false);
  assert.ok(plan.note && plan.note.length > 0, "a blocked round must explain itself in `note`");
});

test("converged: true once a pull has run and nothing is outstanding", () => {
  const plan = buildLoopPlan({ cursor: CURSOR, conflictRegister: EMPTY_REGISTER, failureRegister: EMPTY_REGISTER });
  assert.deepEqual(plan.units, []);
  assert.equal(plan.converged, true);
});

test("unit-id stability: the same outstanding conflict yields the same id across two plans", () => {
  const conflictRegister = updateRegister(EMPTY_REGISTER, [{ id: "ENG-1", reason: "edited locally" }]);

  const first = buildLoopPlan({ cursor: CURSOR, conflictRegister, failureRegister: EMPTY_REGISTER });
  const second = buildLoopPlan({ cursor: CURSOR, conflictRegister, failureRegister: EMPTY_REGISTER });

  assert.equal(first.units.length, 1);
  assert.equal(second.units.length, 1);
  assert.equal(first.units[0].id, second.units[0].id);
  assert.equal(first.units[0].id, "conflict:ENG-1:r1");
  assert.equal(first.converged, false);
});

test("a replanned round after the ticket goes terminal (conflict resolves, then recurs) gets a fresh id", () => {
  // Round 1: ENG-1 conflicts.
  const round1Register = updateRegister(EMPTY_REGISTER, [{ id: "ENG-1", reason: "edited locally" }]);
  const round1Plan = buildLoopPlan({ cursor: CURSOR, conflictRegister: round1Register, failureRegister: EMPTY_REGISTER });
  assert.equal(round1Plan.units[0].id, "conflict:ENG-1:r1");
  assert.equal(round1Plan.converged, false);

  // The ticket for round 1 lands (board-side: it goes terminal) and a later pull sees
  // the conflict is gone — the plugin observes this as the identity dropping out of the
  // current run, i.e. the register marks it resolved.
  const resolvedRegister = updateRegister(round1Register, []);
  const resolvedPlan = buildLoopPlan({ cursor: CURSOR, conflictRegister: resolvedRegister, failureRegister: EMPTY_REGISTER });
  assert.deepEqual(resolvedPlan.units, []);
  assert.equal(resolvedPlan.converged, true, "nothing outstanding once the conflict clears");

  // ENG-1 conflicts again in a later pull. The board only replans once the round-1
  // ticket is terminal (enforced board-side); from the plugin's side, a genuine
  // recurrence must mint a fresh id rather than reusing "conflict:ENG-1:r1", or the
  // board would read it as "already ticketed" and silently do nothing.
  const round2Register = updateRegister(resolvedRegister, [{ id: "ENG-1", reason: "edited locally, again" }]);
  const round2Plan = buildLoopPlan({ cursor: CURSOR, conflictRegister: round2Register, failureRegister: EMPTY_REGISTER });
  assert.equal(round2Plan.units.length, 1);
  assert.equal(round2Plan.units[0].id, "conflict:ENG-1:r2");
  assert.notEqual(round2Plan.units[0].id, round1Plan.units[0].id);
  assert.equal(round2Plan.converged, false);
});

test("push failures are surfaced as their own unit kind, independent of conflicts", () => {
  const failureRegister = updateRegister(EMPTY_REGISTER, [{ id: "board:b1", reason: "no transition to Done" }]);
  const plan = buildLoopPlan({ cursor: CURSOR, conflictRegister: EMPTY_REGISTER, failureRegister });
  assert.equal(plan.units.length, 1);
  assert.equal(plan.units[0].id, "push-failed:board:b1:r1");
  assert.equal(plan.converged, false);
});
