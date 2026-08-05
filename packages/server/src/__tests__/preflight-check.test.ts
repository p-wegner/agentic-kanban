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
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
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
    expect(calls.some((args) => args[0] === "rebase" && args.includes("main"))).toBe(true);
  });

  it("blocks a dirty stale worktree with a checkpoint-first error", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
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

  it("reconciles stale safety files from base branch when rebase does not update them", async () => {
    const calls: string[][] = [];
    const currentBranch = "feature/test";
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "master",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        calls.push(args);
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return `${currentBranch}\n`;
        // rebase does NOT update .codex/hooks.json (simulates branch pre-dating the change)
        if (args[0] === "rebase") return "";
        if (args[0] === "checkout" && args[1] === "master" && args[2] === "--") {
          // Simulate git checkout master -- .codex/hooks.json copying the file
          files.set("worktree:.codex/hooks.json", "new codex hooks");
          return "";
        }
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(calls.some((a) => a[0] === "checkout" && a[1] === "master" && a[2] === "--" && a[3] === ".codex/hooks.json")).toBe(true);
    // Reconciled files must be committed so the agent launches with a clean worktree.
    expect(calls.some((a) => a[0] === "commit")).toBe(true);
  });

  it("does not overwrite a safety file the branch's own commits intentionally modified", async () => {
    const calls: string[][] = [];
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "old codex hooks"],
      ["worktree:.codex/hooks.json", "branch-modified codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "master",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        calls.push(args);
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "feature/test\n";
        if (args[0] === "rebase") return "";
        // The branch's own commits touched .codex/hooks.json relative to master
        if (args[0] === "diff" && args[1] === "--name-only") return ".codex/hooks.json\n";
        if (args[0] === "checkout" && args[1] === "master") {
          throw new Error("must not reconcile a branch-owned safety file");
        }
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    // The branch-owned file is left alone — never checked out from base.
    expect(calls.some((a) => a[0] === "checkout" && a[1] === "master")).toBe(false);
    expect(files.get("worktree:.codex/hooks.json")).toBe("branch-modified codex hooks");
  });

  it("aborts with a loud error instead of looping when the same file was already reconciled once", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "master",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "feature/test\n";
        if (args[0] === "rebase") return "";
        if (args[0] === "diff" && args[1] === "--name-only") return "";
        // A prior [preflight] reconcile commit already touched this exact file once.
        if (args[0] === "log" && args.includes("--")) return "abc123 chore: reconcile safety files from master [preflight]\n";
        if (args[0] === "checkout" && args[1] === "master") {
          throw new Error("must not reconcile again — ping-pong guard should have aborted first");
        }
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("ping-pong");
    expect(result.staleFiles).toContain(".codex/hooks.json");
  });

  it("returns ok=false with stale file list when reconciliation checkout fails", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "master",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "feature/test\n";
        if (args[0] === "rebase") return "";
        if (args[0] === "checkout" && args[1] === "master") throw new Error("checkout failed");
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(false);
    expect(result.staleFiles).toContain(".codex/hooks.json");
    expect(result.errors.join("\n")).toContain("could not be reconciled");
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
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
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
    expect(calls).toContainEqual(["rebase", "--autostash", "main"]);
  });

  it("does not treat a board-materialized skill file as uncommitted changes (#217)", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "hooks"],
      ["worktree:.codex/hooks.json", "hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "old safety guidance"],
      ["worktree:CLAUDE.md", "old safety guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "main",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        if (args[0] === "status") return " M .claude/skills/board-navigator/SKILL.md\n";
        if (args[0] === "rev-parse") return "feature/test\n";
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(result.dirtyFiles).toEqual([]);
  });

  // #217 tail: excluding the skill files from `dirtyFiles` bought nothing on its own — the
  // walk then reached the rebase step, real git REFUSES to rebase a tree it still sees as
  // dirty, and the catch turned that refusal into a preflight error. The workspace was
  // permanently unrelaunchable for churn the board itself wrote.
  it("rebases with --autostash so excluded materialized files do not block the relaunch (#217)", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "hooks"],
      ["worktree:.codex/hooks.json", "hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "old safety guidance"],
      ["worktree:CLAUDE.md", "old safety guidance"],
    ]);
    const calls: string[][] = [];

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: "main",
      branch: "feature/test",
      isDirect: false,
      execGit: async (args) => {
        calls.push(args);
        // A tracked, board-materialized file is modified — invisible to `dirtyFiles`, but
        // NOT to git.
        if (args[0] === "status") return " M .claude/skills/board-navigator/SKILL.md\n";
        if (args[0] === "rev-parse") return "feature/test\n";
        // Model real git: a rebase without --autostash fails on a dirty working tree.
        if (args[0] === "rebase" && !args.includes("--autostash")) {
          throw new Error("error: cannot rebase: You have unstaged changes.");
        }
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(calls).toContainEqual(["rebase", "--autostash", "main"]);
  });

  it("still blocks on a real dirty file alongside an ignored materialized skill file", async () => {
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "new codex hooks"],
      ["worktree:.codex/hooks.json", "old codex hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
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
        if (args[0] === "status") return " M .claude/skills/board-navigator/SKILL.md\n M src/changed.ts\n";
        if (args[0] === "rev-parse") return "feature/test\n";
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(false);
    expect(result.dirtyFiles).toEqual([" M src/changed.ts"]);
  });

  it("repairs configured dependency symlinks before launch", async () => {
    const calls: Array<{ source: string; worktree: string; dirs: string[] }> = [];
    const files = new Map<string, string>([
      ["main:.codex/hooks.json", "hooks"],
      ["worktree:.codex/hooks.json", "hooks"],
      ["main:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["worktree:.claude/hooks/smart-hooks-runner.js", "runner"],
      ["main:.claude/hooks/validate-command-safety.js", "validator"],
      ["worktree:.claude/hooks/validate-command-safety.js", "validator"],
      ["main:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["worktree:.claude/hooks/prevent-cross-worktree-writes.js", "cross-worktree"],
      ["main:CLAUDE.md", "guidance"],
      ["worktree:CLAUDE.md", "guidance"],
    ]);

    const result = await workspaceLaunchPreflight({
      repoPath: "main",
      worktreePath: "worktree",
      baseBranch: null,
      branch: "feature/test",
      isDirect: false,
      symlinkDirs: ["node_modules"],
      bootstrapSymlinks: async (source, worktree, dirs) => {
        calls.push({ source, worktree, dirs });
        return {
          linked: ["node_modules", "packages/server/node_modules"],
          skipped: [],
          failed: [],
        };
      },
      execGit: async (args) => {
        if (args[0] === "status") return "";
        if (args[0] === "rev-parse") return "feature/test\n";
        return "";
      },
      readFile: async (root, path) => files.get(`${root}:${path}`) ?? "",
      exists: async (root, path) => files.has(`${root}:${path}`),
    });

    expect(result.ok).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.repairedSymlinks).toEqual(["node_modules", "packages/server/node_modules"]);
    expect(calls).toEqual([{ source: "main", worktree: "worktree", dirs: ["node_modules"] }]);
  });
});
