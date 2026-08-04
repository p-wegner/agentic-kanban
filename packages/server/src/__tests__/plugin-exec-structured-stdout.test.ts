import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCommand, tailOutput, STRUCTURED_STDOUT_CAP } from "../services/plugin-exec.js";
import { parsePluginLoopPlan } from "@agentic-kanban/shared/lib/plugin-manifest";

/**
 * Regression: a loop plan larger than the diagnostics tail was silently unparseable.
 *
 * `runPluginCommand` keeps only the LAST 16 KB of stdout so a chatty script cannot pin the
 * server's heap. That is right for output read as diagnostics and wrong for output read as DATA:
 * clipping the FRONT off a JSON document makes it fail to parse at every offset, and
 * `parsePluginLoopPlan` then reports "loop plan output is not JSON" — blaming the plugin for the
 * server's truncation. Measured against the safety-net plugin: a 24-module plan is ~23.5 KB, so
 * every many-module target hit this, while a small target (14 modules) stayed under the cap and
 * worked. That is the worst shape of bug — it appears only past a size threshold nobody states.
 */
describe("plugin-exec structured stdout", () => {
  // A plan big enough to blow the 16 KB diagnostics tail, shaped like a real one.
  const bigPlan = JSON.stringify({
    units: Array.from({ length: 24 }, (_, i) => ({
      id: `context-${i}:r1`,
      title: `Requirement extraction: context-${i} — round 1`,
      description: `Mine module \`context-${i}\` for round 1 using fresh lenses L1, L2.\n`.repeat(12),
    })),
    converged: false,
    note: "0/24 modules converged",
  });

  // The emitter is a FILE, not `node -e`: a 25 KB payload and nested quotes do not survive being
  // pasted onto a shell command line — which is the same reason the real planner uses stdout.
  let command = "";
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "plugin-exec-plan-"));
    const planFile = join(dir, "plan.json");
    const emitter = join(dir, "emit.mjs");
    writeFileSync(planFile, bigPlan, "utf8");
    writeFileSync(
      emitter,
      `import { readFileSync } from 'node:fs';\n` +
        `process.stdout.write(readFileSync(${JSON.stringify(planFile)}, 'utf8'));\n`,
      "utf8",
    );
    // Unquoted on purpose: the sanctioned shell spec splits the command into argv itself and does
    // NOT strip quotes, so a quoted path arrives at node with the quotes still attached. The
    // mkdtemp path contains no spaces, so this is safe.
    command = `node ${emitter}`;
  });

  it("the payload under test really is past the old cap", () => {
    expect(bigPlan.length).toBeGreaterThan(16_384);
  });

  it("keeps stdout whole when the caller asks for a structured cap", async () => {
    const result = await runPluginCommand(command, {
      cwd: process.cwd(),
      env: {},
      maxStdoutChars: STRUCTURED_STDOUT_CAP,
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.length).toBe(bigPlan.length);
    expect(result.stdoutTruncated).toBe(false);
    // The point of the fix: the plan survives the trip and parses.
    const plan = parsePluginLoopPlan(result.stdout);
    expect(plan.units).toHaveLength(24);
  });

  it("still tail-truncates by default, and that is why a plan must opt out", async () => {
    const result = await runPluginCommand(command, { cwd: process.cwd(), env: {} });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(16_384);
    // Front clipped ⇒ unparseable at every offset. This is the bug, pinned.
    expect(() => parsePluginLoopPlan(result.stdout)).toThrow(/not JSON/);
  });

  it("tailOutput keeps its default cap for existing callers", () => {
    const text = "x".repeat(20_000);
    expect(tailOutput(text)).toHaveLength(16_384);
    expect(tailOutput(text, 100)).toHaveLength(100);
    expect(tailOutput("short")).toBe("short");
  });
});
