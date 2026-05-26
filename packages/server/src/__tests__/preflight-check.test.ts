import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflightCheck } from "../services/preflight-check.js";

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
