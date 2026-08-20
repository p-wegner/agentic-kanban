// #84 — snapshot-diff for the live Multi-Repo Monitor (which cells flash).
import { describe, it, expect } from "vitest";
import { buildMultiRepoMatrix, normalizeRepoPath, type MatrixRepoInput, type MatrixWorkspaceInput, type RepoMergeStatusEntry, type RepoMergeStatusResponse } from "./multiRepoMatrix.js";
import { diffMultiRepoMatrix, cellKey, type MatrixSnapshot } from "./diffMultiRepoMatrix.js";

const LEADING = "C:\\repos\\backend";
const SIBLING_A = "C:\\repos\\auth-svc";

function repoInputs(): MatrixRepoInput[] {
  return [
    { name: "backend", path: LEADING, isLeading: true },
    { name: "auth-svc", path: SIBLING_A, isLeading: false },
  ];
}

function entry(overrides: Partial<RepoMergeStatusEntry> & { path: string }): RepoMergeStatusEntry {
  return { name: null, isLeading: false, hasWork: false, ahead: 0, merged: false, stranded: false, ...overrides };
}

function status(repos: RepoMergeStatusEntry[]): RepoMergeStatusResponse {
  return { branch: "feature/x", baseBranch: "master", allMerged: repos.every((r) => !r.hasWork || r.merged), repos };
}

function ws(overrides: Partial<MatrixWorkspaceInput> & { id: string }): MatrixWorkspaceInput {
  return { issueNumber: 1, issueTitle: "Ticket", branch: "feature/x", status: "active", mergedAt: null, repoStatus: null, ...overrides };
}

/** Build a snapshot from a list of workspaces (columns follow list order). */
function snapshot(workspaces: MatrixWorkspaceInput[]): MatrixSnapshot {
  return { workspaceIds: workspaces.map((w) => w.id), matrix: buildMultiRepoMatrix(repoInputs(), workspaces) };
}

// The two row keys (normalized repo paths) used across these cases.
const leadingKey = normalizeRepoPath(LEADING);
const siblingKey = normalizeRepoPath(SIBLING_A);

describe("diffMultiRepoMatrix", () => {
  it("flags nothing on the first snapshot (no prior state)", () => {
    const w1 = ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2 })]) });
    expect(diffMultiRepoMatrix(null, snapshot([w1])).size).toBe(0);
  });

  it("detects a cell that changed state and leaves unchanged cells unflagged", () => {
    // w1: leading is ahead↑2, sibling untouched.
    const before = snapshot([
      ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2 }), entry({ path: SIBLING_A })]) }),
    ]);
    // w1: leading landed (merged), sibling still untouched.
    const after = snapshot([
      ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, merged: true }), entry({ path: SIBLING_A })]) }),
    ]);
    const changed = diffMultiRepoMatrix(before, after);
    expect(changed.has(cellKey(leadingKey, "w1"))).toBe(true);
    // The sibling cell (no-change → no-change) must NOT be flagged.
    expect(changed.has(cellKey(siblingKey, "w1"))).toBe(false);
    expect(changed.size).toBe(1);
  });

  it("flags a cell whose ahead-count changed even at the same state", () => {
    const before = snapshot([ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 1 })]) })]);
    const after = snapshot([ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 3 })]) })]);
    const changed = diffMultiRepoMatrix(before, after);
    expect(changed.has(cellKey(leadingKey, "w1"))).toBe(true);
  });

  it("returns an empty set when nothing changed between two identical snapshots", () => {
    const build = () => snapshot([ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2 })]) })]);
    expect(diffMultiRepoMatrix(build(), build()).size).toBe(0);
  });

  it("does not flash a brand-new workspace column, only real transitions of existing ones", () => {
    const before = snapshot([
      ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2 })]) }),
    ]);
    // w2 appears (new column); w1 unchanged.
    const after = snapshot([
      ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2 })]) }),
      ws({ id: "w2", repoStatus: status([entry({ path: SIBLING_A, hasWork: true, ahead: 1 })]) }),
    ]);
    const changed = diffMultiRepoMatrix(before, after);
    expect(changed.size).toBe(0);
  });

  it("flags a cell that gained a value (null → state) for an existing workspace", () => {
    // Before: w1 only reports the leading repo (sibling cell is null).
    const before = snapshot([ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 1 })]) })]);
    // After: w1 now also reports the sibling repo with work.
    const after = snapshot([
      ws({ id: "w1", repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 1 }), entry({ path: SIBLING_A, hasWork: true, ahead: 1 })]) }),
    ]);
    const changed = diffMultiRepoMatrix(before, after);
    expect(changed.has(cellKey(siblingKey, "w1"))).toBe(true);
    expect(changed.has(cellKey(leadingKey, "w1"))).toBe(false);
  });
});
