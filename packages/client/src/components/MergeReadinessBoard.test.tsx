import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildMultiRepoMatrix,
  type MatrixRepoInput,
  type MatrixWorkspaceInput,
  type RepoMergeStatusEntry,
  type RepoMergeStatusResponse,
} from "../lib/multiRepoMatrix.js";
import { MergeReadinessBoard, buildMergeReadinessRows } from "./MergeReadinessBoard.js";

const REPOS: MatrixRepoInput[] = [
  { name: null, path: "/repo/api", isLeading: true },
  { name: "web", path: "/repo/web", isLeading: false },
];

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

function repoStatus(repos: RepoMergeStatusEntry[]): RepoMergeStatusResponse {
  return { branch: "feature/x", baseBranch: "master", allMerged: false, repos };
}

function ws(overrides: Partial<MatrixWorkspaceInput> & { id: string }): MatrixWorkspaceInput {
  return {
    issueNumber: null,
    issueTitle: null,
    branch: null,
    status: "idle",
    mergedAt: null,
    repoStatus: null,
    hasConflicts: false,
    ...overrides,
  };
}

// A mixed fleet: one READY, two BLOCKED (conflict + missing review), one IN-PROGRESS.
// Issue numbers are deliberately out of verdict order to prove READY-first sorting
// beats a plain numeric sort.
const WORKSPACES: MatrixWorkspaceInput[] = [
  ws({
    id: "ready",
    issueNumber: 10,
    status: "ready_for_merge",
    repoStatus: repoStatus([
      entry({ path: "/repo/api", isLeading: true, hasWork: true, ahead: 2 }),
      entry({ path: "/repo/web", name: "web" }),
    ]),
  }),
  ws({
    id: "conflict",
    issueNumber: 2,
    status: "idle",
    hasConflicts: true,
    repoStatus: repoStatus([
      entry({ path: "/repo/api", isLeading: true, hasWork: true, ahead: 1 }),
    ]),
  }),
  ws({
    id: "unreviewed",
    issueNumber: 5,
    status: "idle",
    repoStatus: repoStatus([
      entry({ path: "/repo/api", isLeading: true, hasWork: true, ahead: 3 }),
    ]),
  }),
  ws({
    id: "working",
    issueNumber: 1,
    status: "active",
    repoStatus: repoStatus([
      entry({ path: "/repo/api", isLeading: true, hasWork: true, ahead: 1 }),
    ]),
  }),
];

function rows(workspaces: MatrixWorkspaceInput[]) {
  const matrix = buildMultiRepoMatrix(REPOS, workspaces);
  return buildMergeReadinessRows(matrix, workspaces);
}

describe("buildMergeReadinessRows", () => {
  it("resolves the correct verdict + reason per workspace", () => {
    const byId = Object.fromEntries(rows(WORKSPACES).map((r) => [r.workspace.id, r.verdict]));
    expect(byId.ready).toEqual({ kind: "READY", reason: null });
    expect(byId.conflict).toEqual({ kind: "BLOCKED", reason: "conflicts in api" });
    expect(byId.unreviewed).toEqual({ kind: "BLOCKED", reason: "awaiting review" });
    expect(byId.working).toEqual({ kind: "IN-PROGRESS", reason: "agent working" });
  });

  it("sorts READY first, then BLOCKED, then IN-PROGRESS (not by issue number)", () => {
    expect(rows(WORKSPACES).map((r) => r.workspace.id)).toEqual([
      "ready",
      "conflict",
      "unreviewed",
      "working",
    ]);
  });

  it("shows per-repo status: clean, ahead-N, conflicts, and not-part-of", () => {
    const byId = Object.fromEntries(rows(WORKSPACES).map((r) => [r.workspace.id, r.repos]));
    // READY workspace: api ahead 2, web clean (no changes)
    expect(byId.ready.find((r) => r.label === "api")).toMatchObject({ kind: "ahead", ahead: 2 });
    expect(byId.ready.find((r) => r.label === "web")).toMatchObject({ kind: "clean" });
    // conflict workspace: api conflicts, web not part of the workspace
    expect(byId.conflict.find((r) => r.label === "api")).toMatchObject({ kind: "conflicts" });
    expect(byId.conflict.find((r) => r.label === "web")).toMatchObject({ kind: "not-part-of" });
  });
});

describe("MergeReadinessBoard", () => {
  it("renders one row per workspace with the verdict, READY-first", () => {
    const html = renderToStaticMarkup(
      <MergeReadinessBoard matrix={buildMultiRepoMatrix(REPOS, WORKSPACES)} workspaces={WORKSPACES} />,
    );
    expect(html).toContain("READY");
    expect(html).toContain("BLOCKED");
    expect(html).toContain("IN-PROGRESS");
    expect(html).toContain("conflicts in api");
    expect(html).toContain("awaiting review");
    expect(html).toContain("agent working");
    // READY-first: the first verdict badge in the markup is READY.
    expect(html.indexOf("READY")).toBeLessThan(html.indexOf("BLOCKED"));
    expect(html.indexOf("BLOCKED")).toBeLessThan(html.indexOf("IN-PROGRESS"));
    // Roll-up counts.
    expect(html).toContain("1 ready");
    expect(html).toContain("2 blocked");
  });

  // #comet — a 16-repo project rendered 16 chips per row (~500px tall rows). Above
  // REPO_CHIP_LIMIT the quiet repos collapse into one roll-up chip per kind; the repos
  // that need a decision (ahead / conflicts / unknown) are still listed individually.
  it("collapses the quiet repos into a roll-up chip when a project has many repos", () => {
    const manyRepos: MatrixRepoInput[] = [
      { name: null, path: "/repo/api", isLeading: true },
      ...Array.from({ length: 15 }, (_, i) => ({ name: `sib${i}`, path: `/repo/sib${i}`, isLeading: false })),
    ];
    const workspaces = [
      ws({
        id: "big",
        issueNumber: 1,
        status: "ready_for_merge",
        repoStatus: repoStatus([
          entry({ path: "/repo/api", isLeading: true, hasWork: true, ahead: 4 }),
          ...Array.from({ length: 15 }, (_, i) => entry({ path: `/repo/sib${i}`, name: `sib${i}` })),
        ]),
      }),
    ];
    const html = renderToStaticMarkup(
      <MergeReadinessBoard matrix={buildMultiRepoMatrix(manyRepos, workspaces)} workspaces={workspaces} />,
    );
    // The repo with unlanded work is still named…
    expect(html).toContain("ahead 4");
    expect(html).toContain("api");
    // …the 15 clean ones are one chip, not 15.
    expect(html).toContain("15 clean");
    expect(html).not.toContain("sib7</span>");
  });

  it("lists every repo verbatim below the chip limit", () => {
    const html = renderToStaticMarkup(
      <MergeReadinessBoard matrix={buildMultiRepoMatrix(REPOS, WORKSPACES)} workspaces={WORKSPACES} />,
    );
    expect(html).toContain(">web<");
    // No roll-up chip: every repo is still named individually.
    expect(html).not.toContain("data-repo-rollup");
  });

  it("renders an empty state with no workspaces", () => {
    const html = renderToStaticMarkup(
      <MergeReadinessBoard matrix={buildMultiRepoMatrix(REPOS, [])} workspaces={[]} />,
    );
    expect(html).toContain("No active workspaces");
  });
});
