/**
 * CLI dispatch gate + wrapper output (split out of `cli.test.ts` in #1236; harness in
 * `helpers/cli-harness.ts`). Every case spawns the bundled CLI as a child process (`spawnSync`
 * in the harness), which is why `scripts/test-mine.mjs` excludes this file from the gate.
 * Every case here only READS, so the whole file shares one template-copied DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runCli, runPnpmCli, sharedReadOnlyDb, createCliTestDb, seedProject, type CliTestDb } from "./helpers/cli-harness.js";

// ── dispatch gate (regression: AK-47) ─────────────────────────────────────────
// `pnpm cli -- <subcommand>` must dispatch to commander, not fall through to the
// default action (auto-init + start server). Regression for AK-47, where the
// hand-maintained subcommand list missed --help/--version and other args.

describe("CLI dispatch gate", () => {
  let ctx: CliTestDb;

  beforeAll(() => { ctx = sharedReadOnlyDb(); });
  afterAll(() => { ctx.cleanup(); });

  it("does not start the server when a subcommand is passed", () => {
    const result = runCli(["list"], ctx.dbPath);
    expect(result.status).toBe(0);
    // Server startup banner from cli/index.ts default action — must NOT appear.
    expect(result.stdout).not.toContain("Agentic Kanban is running");
    expect(result.stdout).not.toContain("UI:  http://");
  });

  it("--help prints help and exits without starting the server", () => {
    const result = runCli(["--help"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain("Agentic Kanban is running");
  });

  it("--version prints version and exits without starting the server", () => {
    const result = runCli(["--version"], ctx.dbPath);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Agentic Kanban is running");
  });
});

describe("CLI warning output", () => {
  let ctx: CliTestDb;

  beforeAll(() => { ctx = createCliTestDb(); });
  afterAll(() => { ctx.cleanup(); });

  it("does not emit the DEP0205 module.register warning through the pnpm status wrapper", async () => {
    await seedProject(ctx.dbPath);
    // Deliberately the `pnpm cli` door, not the bundle: the warning flag under test lives in
    // the root package.json script.
    const result = runPnpmCli(["status"], ctx.dbPath);

    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("Board Status: Test Project");
    expect(result.stderr).not.toContain("DEP0205");
  });
});
