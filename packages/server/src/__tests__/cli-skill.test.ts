/**
 * CLI skill commands — list / create / get (split out of `cli.test.ts` in #1236; harness in
 * `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child process (`spawnSync`
 * in the harness), which is why `scripts/test-mine.mjs` excludes this file from the gate.
 * Cases that reject before any insert (unsafe names, a missing skill, the empty listing)
 * share one DB; every `skill create` that succeeds takes a fresh template copy.
 */
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { runCli, createCliTestDb, sharedReadOnlyDb, seedProject, type CliTestDb } from "./helpers/cli-harness.js";

// ── skill commands ────────────────────────────────────────────────────────────

describe("CLI skill list", () => {
  let empty: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });

  it("shows message when no skills", () => {
    const result = runCli(["skill", "list"], empty.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No agent skills found");
  });

  it("lists skills after creation", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const ctx = createCliTestDb();
    try {
      runCli(["skill", "create", "my-skill", "-d", "A test skill", "-p", "Do the thing"], ctx.dbPath);
      const result = runCli(["skill", "list"], ctx.dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("my-skill");
      expect(result.stdout).toContain("A test skill");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("CLI skill create", () => {
  let empty: CliTestDb;
  let ctx: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });
  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("creates a global skill", () => {
    const result = runCli(["skill", "create", "test-skill", "-d", "Test description", "-p", "Test prompt"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'test-skill'");
    expect(result.stdout).toContain("(global)");
  });

  it("creates a project-scoped skill", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    const result = runCli(["skill", "create", "scoped-skill", "-d", "Scoped", "-p", "Prompt", "--project", projectId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'scoped-skill'");
    expect(result.stdout).toContain("project:");
  });

  it("rejects duplicate names in same scope", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    runCli(["skill", "create", "dup-skill", "-p", "Prompt 1"], ctx.dbPath);
    const result = runCli(["skill", "create", "dup-skill", "-p", "Prompt 2"], ctx.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
  });

  it("allows same name in different scopes", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, async () => {
    const { id: projectId } = await seedProject(ctx.dbPath);
    runCli(["skill", "create", "scope-test", "-p", "Global prompt"], ctx.dbPath);
    const result = runCli(["skill", "create", "scope-test", "-p", "Project prompt", "--project", projectId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Created skill 'scope-test'");
  });

  it("rejects unsafe names with slashes", () => {
    const result = runCli(["skill", "create", "evil/skill", "-p", "Prompt"], empty.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot contain");
  });

  it("rejects unsafe names with ..", () => {
    const result = runCli(["skill", "create", "..traversal", "-p", "Prompt"], empty.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot contain");
  });
});

describe("CLI skill get", () => {
  let empty: CliTestDb;
  let ctx: CliTestDb;

  beforeAll(() => { empty = sharedReadOnlyDb(); });
  afterAll(() => { empty.cleanup(); });
  beforeEach(() => { ctx = createCliTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  it("gets a skill by name", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    runCli(["skill", "create", "findable-skill", "-d", "Can be found", "-p", "Test prompt content"], ctx.dbPath);
    const result = runCli(["skill", "get", "findable-skill"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("findable-skill");
    expect(result.stdout).toContain("Test prompt content");
  });

  it("gets a skill by ID", { timeout: GIT_HEAVY_TEST_TIMEOUT_MS }, () => {
    const createResult = runCli(["skill", "create", "by-id-skill", "-p", "Prompt"], ctx.dbPath);
    const idMatch = createResult.stdout.match(/id: ([a-f0-9-]+)/);
    expect(idMatch).toBeTruthy();
    const skillId = idMatch![1];

    const result = runCli(["skill", "get", skillId], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("by-id-skill");
  });

  it("errors for non-existent skill", () => {
    const result = runCli(["skill", "get", "no-such-skill"], empty.dbPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not found");
  });
});
