// #82 — matrix-building logic for the Multi-Repo Monitor panel (repo × workspace).
import { describe, it, expect } from "vitest";
import {
  buildMultiRepoMatrix,
  normalizeRepoPath,
  type MatrixRepoInput,
  type MatrixWorkspaceInput,
  type RepoMergeStatusEntry,
  type RepoMergeStatusResponse,
} from "./multiRepoMatrix.js";

const LEADING = "C:\\repos\\backend";
const SIBLING_A = "C:\\repos\\auth-svc";
const SIBLING_B = "C:\\repos\\inventory-svc";

function repoInputs(): MatrixRepoInput[] {
  return [
    { name: "backend", path: LEADING, isLeading: true },
    { name: "auth-svc", path: SIBLING_A, isLeading: false },
    { name: null, path: SIBLING_B, isLeading: false },
  ];
}

function entry(overrides: Partial<RepoMergeStatusEntry> & { path: string }): RepoMergeStatusEntry {
  return {
    name: null,
    isLeading: false,
    hasWork: false,
    ahead: 0,
    merged: false,
    stranded: false,
    ...overrides,
  };
}

function status(repos: RepoMergeStatusEntry[]): RepoMergeStatusResponse {
  return { branch: "feature/x", baseBranch: "master", allMerged: repos.every((r) => !r.hasWork || r.merged), repos };
}

function ws(overrides: Partial<MatrixWorkspaceInput> & { id: string }): MatrixWorkspaceInput {
  return {
    issueNumber: 1,
    issueTitle: "Ticket",
    branch: "feature/x",
    status: "active",
    mergedAt: null,
    repoStatus: null,
    ...overrides,
  };
}

describe("normalizeRepoPath", () => {
  it("folds separators, trailing slashes, and case", () => {
    expect(normalizeRepoPath("C:\\Repos\\Backend\\")).toBe("c:/repos/backend");
    expect(normalizeRepoPath("c:/repos/backend")).toBe("c:/repos/backend");
  });
});

describe("buildMultiRepoMatrix", () => {
  it("orders rows as given (leading first) and labels unnamed repos by basename", () => {
    const { rows } = buildMultiRepoMatrix(repoInputs(), []);
    expect(rows.map((r) => r.label)).toEqual(["backend", "auth-svc", "inventory-svc"]);
    expect(rows[0].isLeading).toBe(true);
  });

  it("derives no-change / ahead cells for a purely in-flight workspace", () => {
    const workspace = ws({
      id: "w1",
      repoStatus: status([
        entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 2, stranded: true }),
        entry({ path: SIBLING_A }),
        entry({ path: SIBLING_B, hasWork: true, ahead: 1, stranded: true }),
      ]),
    });
    const { rows, summary } = buildMultiRepoMatrix(repoInputs(), [workspace]);
    // In-flight work with nothing merged yet reads as "ahead", not the alarming "stranded".
    expect(rows[0].cells[0]).toEqual({ state: "ahead", ahead: 2 });
    expect(rows[1].cells[0]).toEqual({ state: "no-change", ahead: 0 });
    expect(rows[2].cells[0]).toEqual({ state: "ahead", ahead: 1 });
    expect(summary.strandedWorkspaceCount).toBe(0);
  });

  it("flags unlanded work as stranded once the workspace has (partially) merged", () => {
    const bySibling = ws({
      id: "w1",
      repoStatus: status([
        entry({ path: LEADING, isLeading: true, hasWork: true, ahead: 1, stranded: true }),
        entry({ path: SIBLING_A, hasWork: true, merged: true }),
      ]),
    });
    const byMergedAt = ws({
      id: "w2",
      mergedAt: "2026-07-01T00:00:00.000Z",
      repoStatus: status([
        entry({ path: SIBLING_A, hasWork: true, ahead: 3, stranded: true }),
      ]),
    });
    const { rows, summary } = buildMultiRepoMatrix(repoInputs(), [bySibling, byMergedAt]);
    expect(rows[0].cells[0]).toEqual({ state: "stranded", ahead: 1 });
    expect(rows[1].cells[1]).toEqual({ state: "stranded", ahead: 3 });
    expect(summary.strandedWorkspaceCount).toBe(2);
  });

  it("upgrades unlanded work to conflict when the workspace conflict check fired", () => {
    const workspace = ws({
      id: "w1",
      hasConflicts: true,
      repoStatus: status([
        entry({ path: SIBLING_A, hasWork: true, ahead: 2, stranded: true }),
        entry({ path: SIBLING_B, hasWork: true, merged: true }),
      ]),
    });
    const { rows, summary } = buildMultiRepoMatrix(repoInputs(), [workspace]);
    expect(rows[1].cells[0]).toEqual({ state: "conflict", ahead: 2 });
    // Merged work stays merged — the conflict flag only colors unlanded cells.
    expect(rows[2].cells[0]).toEqual({ state: "merged", ahead: 0 });
    expect(summary.conflictWorkspaceCount).toBe(1);
    expect(summary.strandedWorkspaceCount).toBe(1);
  });

  it("marks every cell unknown when the status fetch failed for a workspace", () => {
    const { rows } = buildMultiRepoMatrix(repoInputs(), [ws({ id: "w1", repoStatus: null })]);
    for (const row of rows) expect(row.cells[0]).toEqual({ state: "unknown", ahead: 0 });
  });

  it("matches entries to rows across path separator/case differences and by the leading flag", () => {
    const workspace = ws({
      id: "w1",
      repoStatus: status([
        // Leading entry reported with a different separator style than the registered path.
        entry({ path: "c:/repos/BACKEND/", isLeading: true, hasWork: true, ahead: 1, stranded: true }),
        entry({ path: "c:/repos/auth-svc", hasWork: true, merged: true }),
      ]),
    });
    const { rows } = buildMultiRepoMatrix(repoInputs(), [workspace]);
    expect(rows).toHaveLength(3);
    // The merged sibling makes the workspace partially merged → unlanded leading work is stranded.
    expect(rows[0].cells[0]?.state).toBe("stranded");
    expect(rows[1].cells[0]?.state).toBe("merged");
  });

  it("appends a row for a repo referenced by a workspace but no longer registered", () => {
    const gone = "C:\\repos\\notifications-svc";
    const workspace = ws({
      id: "w1",
      repoStatus: status([
        entry({ path: gone, name: "notifications-svc", hasWork: true, ahead: 4, stranded: true }),
      ]),
    });
    const { rows, summary } = buildMultiRepoMatrix(repoInputs(), [workspace]);
    expect(rows).toHaveLength(4);
    expect(rows[3].label).toBe("notifications-svc");
    expect(rows[3].cells[0]).toEqual({ state: "ahead", ahead: 4 });
    expect(summary.repoCount).toBe(4);
  });

  it("leaves a null cell when a workspace has no entry for a registered repo", () => {
    const workspace = ws({
      id: "w1",
      repoStatus: status([entry({ path: LEADING, isLeading: true })]),
    });
    const { rows } = buildMultiRepoMatrix(repoInputs(), [workspace]);
    expect(rows[1].cells[0]).toBeNull();
    expect(rows[2].cells[0]).toBeNull();
  });

  it("computes the header summary counts", () => {
    const clean = ws({
      id: "w1",
      repoStatus: status([entry({ path: LEADING, isLeading: true, hasWork: true, merged: true })]),
    });
    const stranded = ws({
      id: "w2",
      mergedAt: "2026-07-01T00:00:00.000Z",
      repoStatus: status([entry({ path: SIBLING_A, hasWork: true, ahead: 2, stranded: true })]),
    });
    const { summary } = buildMultiRepoMatrix(repoInputs(), [clean, stranded]);
    expect(summary).toEqual({
      repoCount: 3,
      workspaceCount: 2,
      strandedWorkspaceCount: 1,
      conflictWorkspaceCount: 0,
    });
  });
});
