/**
 * CLI workspace commands (split out of `cli.test.ts` in #1236; harness in
 * `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child process (`spawnSync`
 * in the harness), which is why `scripts/test-mine.mjs` excludes this file from the gate.
 * The no-project error path shares one DB; the seeded cases take a fresh template copy each.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  runCli, createCliTestDb, sharedReadOnlyDb, seedProject, seedIssue, seedWorkspace,
  type CliTestDb,
} from "./helpers/cli-harness.js";

// ── workspace commands ────────────────────────────────────────────────────────

describe("CLI workspace list", () => {
  let empty: CliTestDb;
  let ctx: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });
  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("errors when no active project", () => {
    const result = runCli(["workspace", "list"], empty.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No active project");
  });

  it("shows message when no issues in project", async () => {
    await seedProject(ctx.dbPath);
    const result = runCli(["workspace", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No workspaces found");
  });

  it("lists workspaces", async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const { id: issueId } = await seedIssue(ctx.dbPath, projectId);
    await seedWorkspace(ctx.dbPath, issueId, { branch: "feature/ws-test", workingDir: "/tmp/ws", status: "active" });

    const result = runCli(["workspace", "list"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feature/ws-test");
  });
});
