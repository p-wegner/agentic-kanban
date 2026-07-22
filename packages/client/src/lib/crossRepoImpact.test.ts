// #97 — pure intensity mapping + matrix build for the Cross-Repo Change-Impact Heatmap.
import { describe, it, expect } from "vitest";
import {
  intensityBucket,
  buildCrossRepoImpact,
  HOT_LINES_THRESHOLD,
  type ImpactRepoInput,
  type ImpactWorkspaceInput,
} from "./crossRepoImpact.js";

const BACKEND = "C:\\repos\\backend";
const AUTH = "C:\\repos\\auth-svc";
const WEB = "C:\\repos\\web";

function repos(): ImpactRepoInput[] {
  return [
    { name: "backend", path: BACKEND, isLeading: true },
    { name: "auth-svc", path: AUTH, isLeading: false },
    { name: "web", path: WEB, isLeading: false },
  ];
}

function ws(
  id: string,
  repoDiffs: ImpactWorkspaceInput["repoDiffs"],
  overrides: Partial<ImpactWorkspaceInput> = {},
): ImpactWorkspaceInput {
  return {
    id,
    issueNumber: 1,
    issueTitle: "Ticket",
    branch: "feature/x",
    status: "active",
    repoDiffs,
    ...overrides,
  };
}

describe("intensityBucket", () => {
  it("is none only when both files and lines are zero", () => {
    expect(intensityBucket(0, 0)).toBe("none");
    expect(intensityBucket(1, 0)).toBe("low");
    expect(intensityBucket(0, 1)).toBe("low");
  });

  it("maps files-changed into ascending buckets", () => {
    expect(intensityBucket(2, 0)).toBe("low");
    expect(intensityBucket(5, 0)).toBe("medium");
    expect(intensityBucket(15, 0)).toBe("high");
    expect(intensityBucket(40, 0)).toBe("severe");
  });

  it("maps lines-changed into ascending buckets", () => {
    expect(intensityBucket(0, 20)).toBe("low");
    expect(intensityBucket(0, 100)).toBe("medium");
    expect(intensityBucket(0, 500)).toBe("high");
    expect(intensityBucket(0, 900)).toBe("severe");
  });

  it("takes the stronger of the two dimensions (a huge single-file rewrite ranks high)", () => {
    // 1 file but 800 lines → severe (lines win); 30 files but 5 lines → severe (files win).
    expect(intensityBucket(1, 800)).toBe("severe");
    expect(intensityBucket(30, 5)).toBe("severe");
    expect(intensityBucket(3, 5)).toBe("medium"); // files:medium(3) beats lines:low(5)
  });
});

describe("buildCrossRepoImpact", () => {
  it("produces one row per workspace and one column per registered repo, aligned", () => {
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [{ path: BACKEND, filesChanged: 3, insertions: 40, deletions: 10 }]),
    ]);
    expect(result.columns.map((c) => c.label)).toEqual(["backend", "auth-svc", "web"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].cells).toHaveLength(3);
    // Cell order matches column order.
    expect(result.rows[0].cells.map((c) => c.repoKey)).toEqual(result.columns.map((c) => c.key));
  });

  it("computes the correct intensity bucket per cell from diff data", () => {
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [
        { path: BACKEND, filesChanged: 1, insertions: 5, deletions: 2 }, // low
        { path: AUTH, filesChanged: 8, insertions: 60, deletions: 30 }, // files 8 → high
      ]),
    ]);
    const [backend, auth, web] = result.rows[0].cells;
    expect(backend.bucket).toBe("low");
    expect(auth.bucket).toBe("high");
    expect(auth.linesChanged).toBe(90);
    expect(web.bucket).toBe("none"); // untouched repo degrades to none
    expect(web.filesChanged).toBe(0);
  });

  it("flags a cross-cutting row when a workspace touches >= 2 repos", () => {
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [
        { path: BACKEND, filesChanged: 2, insertions: 10, deletions: 0 },
        { path: WEB, filesChanged: 1, insertions: 3, deletions: 1 },
      ]),
      ws("w2", [{ path: AUTH, filesChanged: 1, insertions: 4, deletions: 0 }]),
    ]);
    expect(result.rows[0].crossCutting).toBe(true);
    expect(result.rows[0].reposTouched).toBe(2);
    expect(result.rows[1].crossCutting).toBe(false);
    expect(result.summary.crossCuttingCount).toBe(1);
  });

  it("marks a hot column when >= 2 workspaces touch the same repo", () => {
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [{ path: BACKEND, filesChanged: 1, insertions: 5, deletions: 0 }]),
      ws("w2", [{ path: BACKEND, filesChanged: 1, insertions: 2, deletions: 0 }]),
    ]);
    const backend = result.columns.find((c) => c.label === "backend")!;
    const auth = result.columns.find((c) => c.label === "auth-svc")!;
    expect(backend.hot).toBe(true);
    expect(backend.touchingWorkspaceCount).toBe(2);
    expect(auth.hot).toBe(false);
    expect(result.summary.hotRepoCount).toBe(1);
  });

  it("marks a hot column on heavy line churn even with a single workspace", () => {
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [{ path: WEB, filesChanged: 4, insertions: HOT_LINES_THRESHOLD, deletions: 20 }]),
    ]);
    const web = result.columns.find((c) => c.label === "web")!;
    expect(web.touchingWorkspaceCount).toBe(1);
    expect(web.hot).toBe(true);
  });

  it("flags contended cells only in a repo BOTH overlapping workspaces changed", () => {
    const result = buildCrossRepoImpact(
      repos(),
      [
        ws("w1", [
          { path: BACKEND, filesChanged: 2, insertions: 10, deletions: 0 },
          { path: AUTH, filesChanged: 1, insertions: 3, deletions: 0 },
        ]),
        ws("w2", [{ path: BACKEND, filesChanged: 1, insertions: 4, deletions: 0 }]),
      ],
      [{ a: "w1", b: "w2" }],
    );
    const backendCol = result.columns.findIndex((c) => c.label === "backend");
    const authCol = result.columns.findIndex((c) => c.label === "auth-svc");
    // Both workspaces changed backend → contended there.
    expect(result.rows[0].cells[backendCol].contended).toBe(true);
    expect(result.rows[1].cells[backendCol].contended).toBe(true);
    // Only w1 changed auth → NOT contended (w2 has no work there).
    expect(result.rows[0].cells[authCol].contended).toBe(false);
    expect(result.columns[backendCol].contended).toBe(true);
    expect(result.columns[authCol].contended).toBe(false);
    expect(result.summary.contendedRepoCount).toBe(1);
  });

  it("appends a touched-but-unregistered repo as a trailing column", () => {
    const infra = "C:\\repos\\infra";
    const result = buildCrossRepoImpact(repos(), [
      ws("w1", [{ path: infra, name: "infra", filesChanged: 4, insertions: 40, deletions: 5 }]),
    ]);
    expect(result.columns).toHaveLength(4);
    const infraCol = result.columns[3];
    expect(infraCol.label).toBe("infra");
    expect(infraCol.isLeading).toBe(false);
    // The earlier registered columns render as none for this row.
    expect(result.rows[0].cells[0].bucket).toBe("none");
    // 4 files → medium bucket.
    expect(result.rows[0].cells[3].bucket).toBe("medium");
  });

  it("degrades gracefully for an empty / single-repo project", () => {
    const empty = buildCrossRepoImpact(repos(), []);
    expect(empty.rows).toHaveLength(0);
    expect(empty.summary.workspaceCount).toBe(0);
    expect(empty.summary.crossCuttingCount).toBe(0);

    const single = buildCrossRepoImpact(
      [{ name: "backend", path: BACKEND, isLeading: true }],
      [ws("w1", [{ path: BACKEND, filesChanged: 3, insertions: 20, deletions: 5 }])],
    );
    expect(single.columns).toHaveLength(1);
    expect(single.rows[0].crossCutting).toBe(false); // cross-cutting impossible with one repo
    expect(single.rows[0].reposTouched).toBe(1);
  });

  it("ignores an overlap that references an unknown workspace id", () => {
    const result = buildCrossRepoImpact(
      repos(),
      [ws("w1", [{ path: BACKEND, filesChanged: 1, insertions: 2, deletions: 0 }])],
      [{ a: "w1", b: "ghost" }],
    );
    expect(result.rows[0].cells.every((c) => !c.contended)).toBe(true);
    expect(result.summary.contendedRepoCount).toBe(0);
  });
});
