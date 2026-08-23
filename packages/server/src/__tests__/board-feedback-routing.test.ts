import { describe, it, expect } from "vitest";
import {
  detectBoardDeployment,
  isSameRepoPath,
  resolveBoardFeedbackRouting,
} from "../services/board-feedback-routing.js";

/** Minimal stand-in for the project repository's only call here. */
function dbWithProjects(rows: Array<{ id: string; name: string; repoPath: string }>) {
  return {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(rows) }),
    }),
  } as never;
}

const NO_FILES = () => false;

describe("detectBoardDeployment", () => {
  it("reports a container when the board image marker is set", () => {
    expect(detectBoardDeployment("/app", { IS_SANDBOX: "1" }, NO_FILES)).toBe("container");
  });

  it("reports a container when Docker's own in-container marker exists", () => {
    expect(detectBoardDeployment("/app", {}, (p) => p === "/.dockerenv")).toBe("container");
  });

  it("prefers container over source-checkout when a containerized board also ships its source", () => {
    // A container image contains the repo including .git, but nothing edited there survives,
    // so the container classification has to win.
    expect(detectBoardDeployment("/app", { IS_SANDBOX: "1" }, () => true)).toBe("container");
  });

  it("reports packaged for an npm/pnpm dependency install", () => {
    expect(detectBoardDeployment("/home/u/proj/node_modules/agentic-kanban", {}, NO_FILES)).toBe("packaged");
  });

  it("reports packaged for an npx cache path", () => {
    expect(detectBoardDeployment("/home/u/.npm/_npx/abc123/node_modules/agentic-kanban", {}, NO_FILES)).toBe("packaged");
    expect(detectBoardDeployment("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab\\pkg", {}, NO_FILES)).toBe("packaged");
  });

  it("reports a source checkout only when a .git entry is actually present", () => {
    expect(detectBoardDeployment("/src/agentic-kanban", {}, (p) => p.replace(/\\/g, "/").endsWith("/.git"))).toBe(
      "source-checkout",
    );
    // Extracted tarball with no git dir is NOT a development checkout.
    expect(detectBoardDeployment("/opt/agentic-kanban", {}, NO_FILES)).toBe("packaged");
  });
});

describe("isSameRepoPath", () => {
  // Separator direction and case-folding are WINDOWS semantics, and `pathKey` implements
  // them only there — off Windows a backslash is an ordinary filename character and
  // `/srv/Repo` is a different directory from `/srv/repo`, so folding either would be a
  // silent false positive. #828: this assertion had never run off Windows, where it fails.
  it.runIf(process.platform === "win32")(
    "matches paths that differ only by separator, trailing slash, or drive-letter case (win32)",
    () => {
      expect(isSameRepoPath("C:\\projects\\board", "C:/projects/board")).toBe(true);
      expect(isSameRepoPath("C:/projects/board/", "C:/projects/board")).toBe(true);
      expect(isSameRepoPath("c:/projects/board", "C:/PROJECTS/Board")).toBe(true);
    },
  );

  it("matches paths that differ only by a trailing separator, on every platform", () => {
    const board = process.platform === "win32" ? "C:/projects/board" : "/projects/board";
    expect(isSameRepoPath(`${board}/`, board)).toBe(true);
    expect(isSameRepoPath(`${board}//`, board)).toBe(true);
  });

  it.runIf(process.platform !== "win32")("does NOT case-fold off win32", () => {
    expect(isSameRepoPath("/projects/board", "/projects/BOARD")).toBe(false);
  });

  it("does not match different repos or missing values", () => {
    expect(isSameRepoPath("/a/board", "/a/other")).toBe(false);
    expect(isSameRepoPath(null, "/a/board")).toBe(false);
    expect(isSameRepoPath("/a/board", undefined)).toBe(false);
  });
});

describe("resolveBoardFeedbackRouting", () => {
  const boardRoot = "/src/agentic-kanban";

  it("routes to the board's own project when it is registered", async () => {
    const db = dbWithProjects([
      { id: "p-other", name: "pantry", repoPath: "/src/pantry" },
      { id: "p-board", name: "agentic-kanban", repoPath: boardRoot },
    ]);
    const routing = await resolveBoardFeedbackRouting("p-other", db, {
      boardRepoRoot: boardRoot,
      deployment: "source-checkout",
    });
    expect(routing).toEqual({
      kind: "file-ticket",
      projectId: "p-board",
      projectName: "agentic-kanban",
      isCurrentProject: false,
    });
  });

  it("marks isCurrentProject when the worktree being provisioned IS the board's repo", async () => {
    const db = dbWithProjects([{ id: "p-board", name: "agentic-kanban", repoPath: boardRoot }]);
    const routing = await resolveBoardFeedbackRouting("p-board", db, {
      boardRepoRoot: boardRoot,
      deployment: "source-checkout",
    });
    expect(routing).toMatchObject({ kind: "file-ticket", isCurrentProject: true });
  });

  it("still routes to the registered board project even when running packaged or in a container", async () => {
    // A container/npx board driving a bind-mounted, registered board checkout: the operator
    // clearly watches that backlog, so it beats sending them to GitHub.
    const db = dbWithProjects([{ id: "p-board", name: "agentic-kanban", repoPath: boardRoot }]);
    for (const deployment of ["container", "packaged"] as const) {
      const routing = await resolveBoardFeedbackRouting("p-x", db, { boardRepoRoot: boardRoot, deployment });
      expect(routing).toMatchObject({ kind: "file-ticket", projectId: "p-board" });
    }
  });

  it("routes to GitHub when no board project is registered, carrying the deployment reason", async () => {
    const db = dbWithProjects([{ id: "p-other", name: "pantry", repoPath: "/src/pantry" }]);
    const routing = await resolveBoardFeedbackRouting("p-other", db, {
      boardRepoRoot: boardRoot,
      deployment: "container",
      issuesUrl: "https://example.test/issues",
    });
    expect(routing).toEqual({
      kind: "gh-issue",
      issuesUrl: "https://example.test/issues",
      deployment: "container",
    });
  });

  it("never routes a board bug into the project being built", async () => {
    const db = dbWithProjects([{ id: "p-other", name: "pantry", repoPath: "/src/pantry" }]);
    const routing = await resolveBoardFeedbackRouting("p-other", db, {
      boardRepoRoot: boardRoot,
      deployment: "packaged",
    });
    expect(routing?.kind).toBe("gh-issue");
    expect(JSON.stringify(routing)).not.toContain("p-other");
  });
});
