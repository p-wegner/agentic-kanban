// @gate:always-run — requires the live smart-hooks-runner script outside src/; imports nothing it checks (#538).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const runnerPath = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks", "smart-hooks-runner.js");
const { wrongCheckoutVitestReason, isContainerized } = require(runnerPath) as {
  wrongCheckoutVitestReason: (input: unknown, command: string) => string | null;
  isContainerized: () => boolean;
};

describe("smart-hooks-runner wrong-checkout vitest guard", () => {
  // The guard derives the main checkout from git at runtime (portable, no hardcoded path).
  // Pin it deterministically here via the KANBAN_MAIN_CHECKOUT override so the test is
  // machine-independent and matches the fixture paths below regardless of where it runs.
  let priorMainCheckout: string | undefined;
  beforeAll(() => {
    priorMainCheckout = process.env.KANBAN_MAIN_CHECKOUT;
    process.env.KANBAN_MAIN_CHECKOUT = "C:/andrena/agentic-kanban";
  });
  afterAll(() => {
    if (priorMainCheckout === undefined) delete process.env.KANBAN_MAIN_CHECKOUT;
    else process.env.KANBAN_MAIN_CHECKOUT = priorMainCheckout;
  });

  it("blocks test:mine from the main checkout when the session belongs to a worktree", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "PowerShell",
        cwd: "C:/andrena/agentic-kanban",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "pnpm test:mine -- --changed HEAD",
    );

    expect(reason).toContain("Run worktree tests from the worktree root");
    expect(reason).toContain("pnpm test:mine -- --changed HEAD");
  });

  it("blocks explicit cd into the main checkout before vitest", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "Bash",
        cwd: "C:/andrena/.worktrees/feature_ak-123",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "cd C:/andrena/agentic-kanban && pnpm exec vitest packages/server/src/foo.test.ts",
    );

    expect(reason).toContain("main checkout");
  });

  it("allows vitest commands from the worktree", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "PowerShell",
        cwd: "C:/andrena/.worktrees/feature_ak-123/packages/server",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "pnpm exec vitest related src/foo.test.ts",
    );

    expect(reason).toBeNull();
  });
});

describe("smart-hooks-runner isContainerized", () => {
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.AGENTIC_KANBAN_CONTAINER;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.AGENTIC_KANBAN_CONTAINER;
    else process.env.AGENTIC_KANBAN_CONTAINER = prior;
  });

  it("is false when the marker is unset", () => {
    delete process.env.AGENTIC_KANBAN_CONTAINER;
    expect(isContainerized()).toBe(false);
  });

  it("is true when the container wrap sets the marker", () => {
    process.env.AGENTIC_KANBAN_CONTAINER = "1";
    expect(isContainerized()).toBe(true);
  });
});

// End-to-end: a containerized Stop run must skip a containerSkippable host-toolchain check
// (logged, non-blocking) instead of exec'ing it and failing closed — the actual bug behind
// #158 (every turn in a containerized builder ending in a stop-hook-error). A non-containerized
// run of the SAME config must still block on the failing command, proving the skip is
// container-gated rather than a blanket downgrade.
describe("smart-hooks-runner Stop hook — containerized downgrade (#158)", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "smart-hooks-container-"));
    await mkdir(join(projectDir, ".claude", "hooks"), { recursive: true });
    await writeFile(
      join(projectDir, ".claude", "hooks", "smart-hooks-config.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              name: "Host toolchain quick-check",
              command: process.platform === "win32" ? "exit 1" : "false",
              enabled: true,
              blocking: true,
              alwaysRun: true,
              timeout: 10,
              containerSkippable: true,
            },
          ],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function runStop(env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [runnerPath, "Stop"], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: projectDir },
    });
  }

  it("skips the check (no block) when AGENTIC_KANBAN_CONTAINER=1", () => {
    const result = runStop({ AGENTIC_KANBAN_CONTAINER: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Skipped");
    expect(result.stderr).toContain("Host toolchain quick-check");
  });

  it("still blocks on the same failing check outside a container", () => {
    const result = runStop({ AGENTIC_KANBAN_CONTAINER: undefined });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("CHECKS FAILED");
  });
});
