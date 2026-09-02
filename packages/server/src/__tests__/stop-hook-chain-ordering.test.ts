// @gate:always-run — reads/spawns .claude/hooks + settings.json outside src/; imports nothing it checks (#538).
/**
 * Regression tests for ticket #480 — a builder exited with a full, correct, but
 * UNCOMMITTED implementation and the blocking "Uncommitted worktree changes" Stop
 * hook never fired to catch it.
 *
 * Root cause (confirmed): `.claude/settings.json` wired
 * `smart-hooks-runner.js Stop` with no explicit `timeout`, so Claude Code applied
 * its own default (60s) to the OUTER hook process — while the runner's Stop chain
 * could legitimately run for up to 300s (Vitest) + 300s (typecheck) + 10s + 10s +
 * 10s = 630s internally. The outer harness killed the runner long before it ever
 * reached the "Uncommitted worktree changes" check, and a hook killed by the
 * harness's own timeout does not block the Stop event — it just never ran. The
 * branch then looked like the agent produced nothing, when a complete, correct
 * implementation was sitting uncommitted in the worktree the whole time.
 *
 * Two independent defenses:
 *   1. The outer `settings.json` timeout must cover the worst-case sum of the
 *      inner per-check timeouts in `smart-hooks-config.json`.
 *   2. Cheap/critical gates (the uncommitted-changes check) must run BEFORE
 *      expensive ones (Vitest, typecheck), so even an unexpectedly tight outer
 *      budget still lets the critical gate report before it is exhausted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// #1006 — retrying removal for this fixture shape (short-lived temp git repo, every child
// already reaped by the synchronous spawn). An EPERM here is Windows' async handle close, not
// a leak: the gate went red on one while the test's own assertions had passed.
import { rmFixtureDir } from "./helpers/rm-or-report-holder.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SETTINGS_PATH = join(REPO_ROOT, ".claude", "settings.json");
const SMART_CONFIG_PATH = join(REPO_ROOT, ".claude", "hooks", "smart-hooks-config.json");
const RUNNER_PATH = join(REPO_ROOT, ".claude", "hooks", "smart-hooks-runner.js");
const CHECK_UNCOMMITTED_SOURCE = join(REPO_ROOT, ".claude", "hooks", "check-uncommitted.js");

interface StopCheck {
  name: string;
  command: string;
  enabled: boolean;
  blocking?: boolean;
  timeout?: number;
}

function loadStopChecks(): StopCheck[] {
  const config = JSON.parse(readFileSync(SMART_CONFIG_PATH, "utf8")) as { hooks: { Stop: StopCheck[] } };
  return config.hooks.Stop;
}

function findSmartHooksRunnerStopEntry(): { timeout?: number } {
  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as {
    hooks: { Stop: { hooks: { command: string; timeout?: number }[] }[] };
  };
  for (const group of settings.hooks.Stop) {
    for (const hook of group.hooks) {
      if (hook.command.includes("smart-hooks-runner.js Stop")) return hook;
    }
  }
  throw new Error("smart-hooks-runner.js Stop entry not found in .claude/settings.json");
}

describe("Stop hook chain — outer/inner timeout budget (#480)", () => {
  it("gives the outer smart-hooks-runner.js Stop hook a timeout covering the worst-case sum of its inner check timeouts", () => {
    const outer = findSmartHooksRunnerStopEntry();
    expect(typeof outer.timeout).toBe("number");

    const checks = loadStopChecks().filter((c) => c.enabled);
    const worstCaseInnerBudget = checks.reduce((sum, c) => sum + (c.timeout ?? 30), 0);

    // The outer timeout must be able to cover every enabled inner check running to
    // completion — otherwise Claude Code's own hook timeout kills the runner before
    // it reaches later checks (the #480 failure mode), and a harness-killed hook
    // does not block the Stop event.
    expect(outer.timeout!).toBeGreaterThanOrEqual(worstCaseInnerBudget);
  });

  it("runs the Uncommitted worktree changes check before the expensive Vitest/typecheck checks", () => {
    const names = loadStopChecks().map((c) => c.name);
    // Match on WHAT the check is, not on its exact label. The labels are prose and have been
    // renamed before ("TypeScript typecheck" -> "Typecheck (edited packages only)" in
    // 9e60a3987c), which turned this ordering guard red on master while the ordering it
    // guards was still perfectly correct — a rename cannot be allowed to read as a defect.
    const findIdx = (re: RegExp) => names.findIndex((n) => re.test(n));
    const uncommittedIdx = findIdx(/uncommitted/i);
    const vitestIdx = findIdx(/vitest/i);
    const typecheckIdx = findIdx(/typecheck/i);

    expect(uncommittedIdx).toBeGreaterThanOrEqual(0);
    expect(vitestIdx).toBeGreaterThanOrEqual(0);
    expect(typecheckIdx).toBeGreaterThanOrEqual(0);

    // Cheap/critical gate first — defense in depth against any future under-provisioned
    // outer timeout: even a tight budget still lets this gate run and report.
    expect(uncommittedIdx).toBeLessThan(vitestIdx);
    expect(uncommittedIdx).toBeLessThan(typecheckIdx);
  });
});

describe("Stop hook chain — check-uncommitted actually blocks agent exit on a dirty worktree (#480)", () => {
  function makeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "ak-stop-hook-uncommitted-"));
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(dir, "packages", "shared", "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "hooks", "check-uncommitted.js"),
      readFileSync(CHECK_UNCOMMITTED_SOURCE, "utf8"),
    );
    writeFileSync(
      join(dir, ".claude", "hooks", "smart-hooks-config.json"),
      JSON.stringify(
        {
          hooks: {
            Stop: [
              // A fast preceding check, mirroring "cheap gates" running ahead of the
              // uncommitted check in the real chain — proves it still runs and blocks.
              {
                name: "Fast preceding check",
                command: process.platform === "win32" ? "exit 0" : "true",
                enabled: true,
                blocking: true,
                alwaysRun: true,
                timeout: 10,
              },
              {
                name: "Uncommitted worktree changes",
                command: "node .claude/hooks/check-uncommitted.js",
                enabled: true,
                blocking: true,
                timeout: 10,
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(join(dir, "packages", "shared", "src", "lib", "foo.ts"), "export const foo = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
    return dir;
  }

  function runStop(dir: string) {
    return spawnSync(process.execPath, [RUNNER_PATH, "Stop"], {
      input: JSON.stringify({ stop_hook_active: false, session_id: "no-such-session" }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: dir,
        // #1006 — pin both policy gates so this suite asserts the CHAIN, never a machine reading.
        // The uncommitted check classifies as `other` today (so neither gate reaches it), but that
        // is a property of its name: rename it to anything matching /\btests?\b/ and the capacity
        // gate would start skipping it below 2GB free, turning this into the same load-dependent
        // red the typecheck suite hit. Pinning costs nothing and removes the standing trap.
        SMART_HOOKS_FORCE: "1",
        SMART_HOOKS_POSTURE: "standard",
      },
    });
  }

  it("blocks agent exit when tracked source changes are uncommitted", () => {
    const dir = makeFixture();
    try {
      const edited = join(dir, "packages", "shared", "src", "lib", "foo.ts");
      writeFileSync(edited, "export const foo = 2; // uncommitted edit\n");
      // Age the edit past #884's fresh-foreign window (2 min): a just-written file with no
      // strong attribution is deliberately not demanded (it may be another live session's
      // hand mid-edit); PAST the window it returns to stranded — which is the #480 property
      // this test pins. The blocking path for a real builder is unaffected: its Write-tool
      // edits carry strong attribution and are demanded regardless of mtime.
      const aged = (Date.now() - 3 * 60 * 1000) / 1000;
      utimesSync(edited, aged, aged);
      const result = runStop(dir);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain("CHECKS FAILED");
      expect(result.stdout).toContain("Uncommitted");
    } finally {
      rmFixtureDir(dir);
    }
  });

  it("allows agent exit when the worktree is clean", () => {
    const dir = makeFixture();
    try {
      const result = runStop(dir);
      expect(result.status).toBe(0);
    } finally {
      rmFixtureDir(dir);
    }
  });
});
