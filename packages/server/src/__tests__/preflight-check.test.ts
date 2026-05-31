import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflightCheck, workspaceLaunchPreflight } from "../services/preflight-check.js";

const TEST_DIR = join(tmpdir(), "preflight-test-" + process.pid);

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("preflightCheck", () => {
  it("passes for a healthy worktree with .git file and env vars", () => {
    writeFileSync(join(TEST_DIR, ".git"), "gitdir: /some/main/repo/.git/worktrees/abc");
    process.env.KANBAN_SERVER_PORT = "3001";
    process.env.KANBAN_CLIENT_PORT = "5173";

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);

    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.KANBAN_CLIENT_PORT;
  });

  it("passes for a direct workspace (no .git check)", () => {
    // Direct workspace doesn't need .git file
    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.KANBAN_CLIENT_PORT;
    process.env.PORT = "3001";
    process.env.VITE_PORT = "5173";

    const result = preflightCheck(TEST_DIR, true);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);

    delete process.env.PORT;
    delete process.env.VITE_PORT;
  });

  it("fails when worktree directory does not exist", () => {
    const result = preflightCheck(join(TEST_DIR, "nonexistent"), false);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("does not exist");
  });

  it("fails when .git is missing in non-direct worktree", () => {
    process.env.KANBAN_SERVER_PORT = "3001";
    process.env.KANBAN_CLIENT_PORT = "5173";

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes(".git not found"))).toBe(true);

    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.KANBAN_CLIENT_PORT;
  });

  it("fails when KANBAN_SERVER_PORT and PORT are not set", () => {
    writeFileSync(join(TEST_DIR, ".git"), "gitdir: /some/path");
    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.PORT;
    process.env.KANBAN_CLIENT_PORT = "5173";

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("KANBAN_SERVER_PORT"))).toBe(true);

    delete process.env.KANBAN_CLIENT_PORT;
  });

  it("fails when KANBAN_CLIENT_PORT and VITE_PORT are not set", () => {
    writeFileSync(join(TEST_DIR, ".git"), "gitdir: /some/path");
    process.env.KANBAN_SERVER_PORT = "3001";
    delete process.env.KANBAN_CLIENT_PORT;
    delete process.env.VITE_PORT;

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("KANBAN_CLIENT_PORT"))).toBe(true);

    delete process.env.KANBAN_SERVER_PORT;
  });

  it("reports multiple errors at once", () => {
    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.PORT;
    delete process.env.KANBAN_CLIENT_PORT;
    delete process.env.VITE_PORT;

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(false);
    // .git missing + no server port + no client port
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts PORT as fallback for KANBAN_SERVER_PORT", () => {
    writeFileSync(join(TEST_DIR, ".git"), "gitdir: /some/path");
    delete process.env.KANBAN_SERVER_PORT;
    process.env.PORT = "3001";
    process.env.KANBAN_CLIENT_PORT = "5173";

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(true);

    delete process.env.PORT;
    delete process.env.KANBAN_CLIENT_PORT;
  });

  it("accepts VITE_PORT as fallback for KANBAN_CLIENT_PORT", () => {
    writeFileSync(join(TEST_DIR, ".git"), "gitdir: /some/path");
    process.env.KANBAN_SERVER_PORT = "3001";
    delete process.env.KANBAN_CLIENT_PORT;
    process.env.VITE_PORT = "5173";

    const result = preflightCheck(TEST_DIR, false);
    expect(result.ok).toBe(true);

    delete process.env.KANBAN_SERVER_PORT;
    delete process.env.VITE_PORT;
  });
});

describe("workspaceLaunchPreflight", () => {
  it("rebases a clean stale worktree before launch and passes once safety files match", async () => {
    const calls: string[][] = [];
    let currentBranch = "feature/test";
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:CLAUDE.md", "current safety guidance"],
      ["worktree:CLAUDE.md", "old safety guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "main",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        calls.push(args);
        if (args[0] === "status") return "";
        if (args[0] === "rebase") {
          files.set("worktree:.codex/hooks.json", "new codex hooks");
          files.set("worktree:CLAUDE.md", "current safety guidance");
          return "";
        }
        if (args[0] === "rev-parse") return `${currentBranch}\n`;
        if (args[0] === "checkout") {
          currentBranch = args[1];
          return "";
        }
        if (args[0] === "branch") return "";
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(calls.some((args) => args[0] === "rebase" && args[1] === "main")).toBe(true);
  });

  it("blocks a dirty stale worktree with a checkpoint-first error", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:CLAUDE.md", "current safety guidance"],
      ["worktree:CLAUDE.md", "old safety guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "main",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        if (args[0] === "status") return " M src/changed.ts\n";
        if (args[0] === "rev-parse") return "feature/test\n";
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("checkpoint/commit");
    expect(result.errors.join("\n")).toContain(".codex/hooks.json");
    expect(result.errors.join("\n")).toContain("CLAUDE.md");
  });

  it("reattaches a clean detached worktree to the workspace branch before rebasing", async () => {
    const calls: string[][] = [];
    let currentBranch: string | null = null;
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "hooks"],
      ["worktree:.codex/hooks.json", "hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "main",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        calls.push(args);
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return currentBranch ? `${currentBranch}\n` : "HEAD\n";
        if (args[0] === "checkout") {
          currentBranch = args[1];
          return "";
        }
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(calls).toContainEqual(["checkout", "feature/test"]);
    expect(calls).toContainEqual(["rebase", "main"]);
  });
});
