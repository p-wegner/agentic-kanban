// @gate:always-run — spawns the live smart-hooks-runner script outside src/; imports nothing it checks (#538).
/**
 * #913 — the Stop chain reads the project's RISK POSTURE, and every spawn goes through
 * the capacity gate.
 *
 * The acceptance criterion is stated in terms of what a worktree SPAWNS: a `sprint`
 * worktree's Stop chain spawns no tsc/vitest, a `strict` one does. So the expensive
 * checks in these fixtures are commands that leave a FILE behind when they run — a
 * spawn is then observable directly, instead of being inferred from a log line that
 * could be printed without ever spawning anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const HOOKS_DIR = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks");
const runnerPath = join(HOOKS_DIR, "smart-hooks-runner.js");

const posture = require(join(HOOKS_DIR, "hook-posture.js")) as {
  normalizePosture: (v: unknown) => string;
  parsePostureFromTicketContext: (text: string) => string | null;
  policyFor: (p: string) => { typecheck: boolean; tests: boolean; generatedRules: boolean; capacityGated: boolean };
  classifyCheck: (check: unknown) => string;
  checkAllowedUnderPosture: (
    check: unknown,
    p: string,
  ) => { run: boolean; kind: string; reason: string | null };
};

describe("hook posture resolution (#913)", () => {
  it("resolves an unknown, absent or mistyped posture to standard, never to a weaker one", () => {
    for (const bad of ["", "SPRINTY", "yolo", null, undefined, 42, "  "]) {
      expect(posture.normalizePosture(bad)).toBe("standard");
    }
  });

  it("reads the posture the board renders into the ticket-context file", () => {
    const rendered =
      "## Risk posture\n\n" +
      "This project runs under **Sprint** risk posture. Skips pre-merge review entirely.\n" +
      "A ticket tagged `risk:<posture>` overrides the project default for that ticket only.\n";
    // The documentation line's literal `risk:<posture>` must NOT be mistaken for a tag.
    expect(posture.parsePostureFromTicketContext(rendered)).toBe("sprint");
  });

  it("lets a ticket-level risk: tag override the project default", () => {
    const rendered =
      "This project runs under **Strict** risk posture.\n\nTags: risk:fast, area:hooks\n";
    expect(posture.parsePostureFromTicketContext(rendered)).toBe("fast");
  });

  it("returns null when there is no posture section at all, so absent is not 'explicitly standard'", () => {
    expect(posture.parsePostureFromTicketContext("# Ticket #913\n\nSome description.\n")).toBeNull();
  });
});

describe("hook posture policy (#913)", () => {
  it("runs typecheck+tests under strict and standard, and only differs on capacity gating", () => {
    expect(posture.policyFor("strict")).toMatchObject({ typecheck: true, tests: true, capacityGated: false });
    expect(posture.policyFor("standard")).toMatchObject({ typecheck: true, tests: true, capacityGated: true });
  });

  it("drops tests under fast and everything speculative under sprint", () => {
    expect(posture.policyFor("fast")).toMatchObject({ typecheck: true, tests: false, generatedRules: false });
    expect(posture.policyFor("sprint")).toMatchObject({ typecheck: false, tests: false, generatedRules: false });
  });

  it("NEVER skips a safety check, at any posture — the one invariant", () => {
    const safety = { name: "Validate command safety", command: "node .claude/hooks/validate-command-safety.js", alwaysRun: true };
    for (const level of ["strict", "standard", "fast", "sprint"]) {
      expect(posture.classifyCheck(safety)).toBe("safety");
      expect(posture.checkAllowedUnderPosture(safety, level).run).toBe(true);
    }
  });

  it("classifies the generated stack rules so they can be gated at all (they bypassed everything)", () => {
    expect(posture.classifyCheck({ command: "pnpm test", generated: true })).toBe("generatedRules");
    expect(posture.checkAllowedUnderPosture({ command: "pnpm test", generated: true }, "sprint").run).toBe(false);
    expect(posture.checkAllowedUnderPosture({ command: "pnpm test", generated: true }, "standard").run).toBe(true);
  });

  it("leaves an unclassifiable check alone rather than silently disabling it", () => {
    const unknown = { name: "Remind Playwright", command: "node .claude/hooks/remind-playwright.js" };
    expect(posture.classifyCheck(unknown)).toBe("other");
    expect(posture.checkAllowedUnderPosture(unknown, "sprint").run).toBe(true);
  });

  it("says plainly that nothing was verified when it skips", () => {
    const skipped = posture.checkAllowedUnderPosture(
      { name: "Vitest (edited files only)", command: "node .claude/hooks/scoped-vitest.js" },
      "sprint",
    );
    expect(skipped.run).toBe(false);
    expect(skipped.reason).toContain("NOTHING was verified");
    expect(skipped.reason).toContain("pre-merge gate");
  });
});

describe("Stop chain honours the posture end-to-end (#913)", () => {
  let projectDir: string;

  /** A command that CREATES `marker` — so "did it spawn?" is answered by the filesystem. */
  function touchCommand(name: string) {
    const marker = join(projectDir, name).replace(/\\/g, "/");
    return `node -e "require('fs').writeFileSync(process.argv[1],'ran')" "${marker}"`;
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "ak-hook-posture-"));
    await mkdir(join(projectDir, ".claude", "hooks"), { recursive: true });
    await writeFile(
      join(projectDir, ".claude", "hooks", "smart-hooks-config.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              // Named exactly as the real config names it, so the runner classifies it into
              // the typecheck bucket — while actually only touching a marker file, which is
              // what makes "did it spawn?" a filesystem question rather than a log question.
              name: "Typecheck (edited packages only)",
              command: touchCommand("tsc.marker"),
              enabled: true,
              blocking: true,
              timeout: 30,
            },
            {
              name: "Vitest (edited files only)",
              command: touchCommand("vitest.marker"),
              enabled: true,
              blocking: true,
              timeout: 30,
            },
            {
              name: "Remind Cleanup",
              command: touchCommand("safety.marker"),
              enabled: true,
              blocking: true,
              alwaysRun: true,
              timeout: 30,
            },
          ],
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  function runStop(postureLevel: string) {
    return spawnSync(process.execPath, [runnerPath, "Stop"], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SMART_HOOKS_POSTURE: postureLevel,
        // Take the capacity heuristic out of the picture: this test is about POSTURE,
        // and a loaded CI box would otherwise hold the strict run too.
        SMART_HOOKS_FORCE: "1",
      },
    });
  }

  it("a sprint worktree spawns no tsc and no vitest, but still runs the safety check", () => {
    const result = runStop("sprint");
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, "tsc.marker"))).toBe(false);
    expect(existsSync(join(projectDir, "vitest.marker"))).toBe(false);
    expect(existsSync(join(projectDir, "safety.marker"))).toBe(true);
    expect(result.stderr).toContain("risk posture");
  });

  it("a strict worktree spawns both", () => {
    const result = runStop("strict");
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, "tsc.marker"))).toBe(true);
    expect(existsSync(join(projectDir, "vitest.marker"))).toBe(true);
    expect(existsSync(join(projectDir, "safety.marker"))).toBe(true);
  });

  it("a fast worktree typechecks but does not test", () => {
    const result = runStop("fast");
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, "tsc.marker"))).toBe(true);
    expect(existsSync(join(projectDir, "vitest.marker"))).toBe(false);
  });

  it("the capacity gate holds only the checks that spawn a build, never the cheap guards", async () => {
    // The capacity gate exists to keep a BUILD off a box that cannot afford one. Gating
    // every non-`alwaysRun` check also held `check-uncommitted.js` — a cheap `git status`
    // that catches stranded work at session exit — exactly when the box is loaded and
    // several agents are running, which is when stranding is most likely. It also
    // contradicted the posture module, which deliberately leaves an unclassifiable
    // ("other") check alone rather than disabling what it does not understand.
    await writeFile(
      join(projectDir, ".claude", "hooks", "smart-hooks-config.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            // Classifies as "other": cheap, not a build, and carries no alwaysRun flag —
            // the exact shape that was being held.
            {
              name: "Uncommitted worktree changes",
              command: touchCommand("uncommitted.marker"),
              enabled: true,
              blocking: true,
              timeout: 30,
            },
            {
              name: "Typecheck (edited packages only)",
              command: touchCommand("tsc.marker"),
              enabled: true,
              blocking: true,
              timeout: 30,
            },
          ],
        },
      }),
    );
    const result = spawnSync(process.execPath, [runnerPath, "Stop"], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SMART_HOOKS_POSTURE: "standard",
        // Demand more free memory than any machine has, so the gate always holds.
        SMART_HOOKS_MIN_FREE_GB: "99999",
        SMART_HOOKS_FORCE: "0",
      },
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, "uncommitted.marker"))).toBe(true);
    expect(existsSync(join(projectDir, "tsc.marker"))).toBe(false);
  });

  it("a held capacity check reports inconclusive and names the train gate", () => {
    // Force a hold by demanding more free memory than any machine has.
    const result = spawnSync(process.execPath, [runnerPath, "Stop"], {
      input: JSON.stringify({ stop_hook_active: false }),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SMART_HOOKS_POSTURE: "standard",
        SMART_HOOKS_MIN_FREE_GB: "99999",
        SMART_HOOKS_FORCE: "0",
      },
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(projectDir, "tsc.marker"))).toBe(false);
    expect(existsSync(join(projectDir, "vitest.marker"))).toBe(false);
    // The safety check is never capacity-gated — that is the invariant.
    expect(existsSync(join(projectDir, "safety.marker"))).toBe(true);
    expect(result.stderr).toContain("train gate");
  });
});
