/**
 * #116 — ticket-sizing floor for the epic splitter. `coalesceTestOnlyChildren` keeps a
 * test in the same vertical slice as the code it covers and flags an over-split that
 * shouldn't have happened (an already single-session-sized epic). These are pure functions,
 * so no DB/LLM — the guard is the deterministic backstop for when the prompt's ask is ignored.
 *
 * The canonical case is the one the board-tuning-lab observed live: decomposing an atomic
 * "add GET /api/version" ticket produced ["add the route", "add a test for the route"] with
 * a depends_on edge — two workspaces for one line of work.
 */
import { describe, it, expect } from "vitest";
import {
  isTestOnlyChild,
  coalesceTestOnlyChildren,
  type DecomposeChildProposal,
  type DecomposeDependencyProposal,
} from "../services/issue-ai.service.js";

function child(tempId: string, title: string, description = ""): DecomposeChildProposal {
  return { tempId, title, description, priority: "medium", targetRepo: null };
}
const dep = (from: string, to: string): DecomposeDependencyProposal => ({
  fromTempId: from,
  toTempId: to,
  type: "depends_on",
});

describe("isTestOnlyChild", () => {
  it("flags a test-follow-on that depends on exactly one implementation sibling", () => {
    expect(isTestOnlyChild(child("c2", "Add node:test coverage for GET /api/version"), ["c1"])).toBe(true);
    expect(isTestOnlyChild(child("c2", "Write unit tests for normalizeTag"), ["c1"])).toBe(true);
  });

  it("does NOT flag a standalone test epic (no single implementation dependency)", () => {
    // A genuine "build the test harness" child has no depends_on to a sibling → left alone.
    expect(isTestOnlyChild(child("c1", "Add integration test harness"), [])).toBe(false);
    // Depends on two siblings → not a straight code+test pair.
    expect(isTestOnlyChild(child("c3", "Add end-to-end tests"), ["c1", "c2"])).toBe(false);
  });

  it("does NOT flag implementation children that merely mention tests", () => {
    expect(isTestOnlyChild(child("c1", "Implement validateTag and its tests"), ["c0"])).toBe(false);
    expect(isTestOnlyChild(child("c1", "Add POST /api/items/:id/tags route"), ["c0"])).toBe(false);
  });
});

describe("coalesceTestOnlyChildren", () => {
  it("collapses the observed atomic over-split (route + test-for-route) into one right-sized ticket", () => {
    const children = [
      child("c1", "Add GET /api/version route returning {version:'0.0.0'}"),
      child("c2", "Add node:test coverage for GET /api/version"),
    ];
    const deps = [dep("c2", "c1")];

    const out = coalesceTestOnlyChildren(children, deps);

    expect(out.children.map((c) => c.tempId)).toEqual(["c1"]);
    expect(out.coalescedTestOnly).toEqual(["c2"]);
    expect(out.tooSmallToDecompose).toBe(true);
    expect(out.dependencies).toEqual([]); // the only edge pointed at/from the dropped child
    // the test intent is folded into the surviving implementation ticket
    expect(out.children[0].description).toMatch(/Include tests in this ticket/i);
    expect(out.children[0].description).toMatch(/node:test coverage for GET \/api\/version/i);
  });

  it("leaves a genuine multi-seam split untouched and does not flag it as too small", () => {
    const children = [
      child("c1", "Implement tag-core: normalizeTag, validateTag, MAX_TAG_LENGTH"),
      child("c2", "Build tag-api store + REST routes"),
      child("c3", "Implement tag-ui rendering helpers"),
    ];
    const deps = [dep("c2", "c1"), dep("c3", "c1")];

    const out = coalesceTestOnlyChildren(children, deps);

    expect(out.children.map((c) => c.tempId)).toEqual(["c1", "c2", "c3"]);
    expect(out.coalescedTestOnly).toEqual([]);
    expect(out.tooSmallToDecompose).toBe(false);
    expect(out.dependencies).toEqual(deps);
  });

  it("rewires an edge that pointed at a coalesced test child onto its implementation target", () => {
    // c2 is a test-only follow-on to c1; c3 (real work) depends on c2 → should end up on c1.
    const children = [
      child("c1", "Add POST /api/items/:id/tags route"),
      child("c2", "Add tests for the POST tags route"),
      child("c3", "Add GET /api/items/:id/tags route"),
    ];
    const deps = [dep("c2", "c1"), dep("c3", "c2")];

    const out = coalesceTestOnlyChildren(children, deps);

    expect(out.children.map((c) => c.tempId).sort()).toEqual(["c1", "c3"]);
    expect(out.coalescedTestOnly).toEqual(["c2"]);
    expect(out.tooSmallToDecompose).toBe(false); // two real children survive
    // c3 → c2 got rewired to c3 → c1; the c2 → c1 edge vanished with c2
    expect(out.dependencies).toEqual([dep("c3", "c1")]);
  });

  it("flags a single-child proposal as too small even with no test children to coalesce", () => {
    const out = coalesceTestOnlyChildren([child("c1", "Add a health endpoint")], []);
    expect(out.tooSmallToDecompose).toBe(true);
    expect(out.coalescedTestOnly).toEqual([]);
  });
});
