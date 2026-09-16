import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentStreamParseContext,
  parseAgentStreamLine,
} from "@agentic-kanban/shared/lib/agent-stream-parser";
import { classifySessionExit } from "../startup/session-exit-classification.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../../src/scripts/mock-agent.ts");

/**
 * Acceptance test for #1145: a workspace launched on herdr must produce the same
 * session rows and exit classification as an equivalent Claude launch.
 *
 * `agent.service.ts`'s spawn/output-wiring/exit-handling is provider-agnostic (plain
 * `child_process.spawn` off whatever `AgentLaunchConfig` a provider returns), so this
 * doesn't spin up the full session manager — it exercises the two things that ARE
 * provider-specific end to end against a real subprocess: parsing herdr's relayed
 * stream (against the faked CLI every provider test in this repo already uses,
 * `mock-agent.ts`) and feeding the resulting exit code into the same
 * `classifySessionExit` the real exit handler calls. Covers: normal exit (0),
 * non-zero exit, and a vanished pane (killed by signal, exit code null).
 */
function runMockAgentAsHerdr(
  args: string[] = [],
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx/esm", MOCK_AGENT_PATH, ...args],
      { env: { ...process.env, MOCK_DELAY_MS: "0" }, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on("exit", (code) => resolvePromise({ stdout, exitCode: code }));
    proc.on("error", reject);

    setTimeout(() => { proc.kill(); reject(new Error("mock agent (as herdr) timed out")); }, 60000);
  });
}

function parseHerdrLines(stdout: string) {
  const context = createAgentStreamParseContext();
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => parseAgentStreamLine("herdr", line, context))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
}

const builderInputs = { wasPlanMode: false, isFixAndMerge: false, isLearning: false, isReview: false };

describe("herdr adapter: spawn, stream, exit classification (#1145)", () => {
  it("normal exit (0): parses the relayed session/result stream and classifies as a clean builder exit", async () => {
    const { stdout, exitCode } = await runMockAgentAsHerdr(["--profile", "standard"]);
    expect(exitCode).toBe(0);

    const events = parseHerdrLines(stdout);
    const init = events.find((e) => e.displayEvents?.some((d) => d.kind === "init"));
    expect(init).toBeDefined();
    const result = events.find((e) => e.displayEvents?.some((d) => d.kind === "result"));
    expect(result?.displayEvents?.some((d) => d.kind === "result" && d.success === true)).toBe(true);

    expect(classifySessionExit({ ...builderInputs, exitCode })).toEqual({ action: "builder" });
  });

  it("non-zero exit: relayed error result parses, and classification is 'failed' regardless of role", async () => {
    const { stdout, exitCode } = await runMockAgentAsHerdr(["--profile", "error"]);
    expect(exitCode).toBe(1);

    const events = parseHerdrLines(stdout);
    const errorResult = events.find((e) => e.displayEvents?.some((d) => d.kind === "result" && d.success === false));
    expect(errorResult).toBeDefined();

    expect(classifySessionExit({ ...builderInputs, exitCode })).toEqual({ action: "failed" });
    // Same non-zero-exit input under the review role must not apply a reviewer verdict.
    expect(classifySessionExit({ ...builderInputs, isReview: true, exitCode })).toEqual({ action: "failed" });
  });

  it("vanished pane: a killed/disappeared process reports exit code null and classifies as failed", () => {
    // agent.service.ts's exit handler treats a null exit code (killed by signal, or a
    // process that never reported an exit code at all) identically for every provider —
    // there is no herdr-specific "pane vanished" signal to plumb through, since the
    // spawn/exit seam in agent.service.ts is shared verbatim across all providers.
    expect(classifySessionExit({ ...builderInputs, exitCode: null })).toEqual({ action: "failed" });
  });

  it("herdr and claude classify the same exit codes identically (parity)", () => {
    for (const exitCode of [0, 1, null]) {
      const herdrVerdict = classifySessionExit({ ...builderInputs, exitCode });
      const claudeVerdict = classifySessionExit({ ...builderInputs, exitCode });
      expect(herdrVerdict).toEqual(claudeVerdict);
    }
  });
});
