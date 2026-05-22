import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = resolve(__dirname, "../../src/scripts/mock-agent.ts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runMockAgent(args: string[] = []): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx/esm", MOCK_AGENT_PATH, ...args],
      { env: { ...process.env, MOCK_DELAY_MS: "0" }, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", reject);

    setTimeout(() => { proc.kill(); reject(new Error("mock-agent timed out")); }, 10000);
  });
}

function parseEvents(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("mock-agent error profile", () => {
  it("exits with code 1", async () => {
    const { exitCode } = await runMockAgent(["--profile", "error"]);
    expect(exitCode).toBe(1);
  });

  it("emits init event followed by assistant text and error result", async () => {
    const { stdout } = await runMockAgent(["--profile", "error"]);
    const events = parseEvents(stdout) as any[];

    expect(events.length).toBeGreaterThanOrEqual(3);

    const first = events[0];
    expect(first.type).toBe("system");
    expect(first.subtype).toBe("init");
    expect(first.session_id).toMatch(UUID_RE);

    const textEvents = events.filter(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "text"),
    );
    expect(textEvents.length).toBeGreaterThanOrEqual(1);

    const last = events[events.length - 1] as any;
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("error");
    expect(last.is_error).toBe(true);
  });

  it("result event has valid session_id and numeric duration_ms", async () => {
    const { stdout } = await runMockAgent(["--profile", "error"]);
    const events = parseEvents(stdout) as any[];

    const result = events.find((e: any) => e.type === "result") as any;
    expect(result).toBeDefined();
    expect(result.session_id).toMatch(UUID_RE);
    expect(typeof result.duration_ms).toBe("number");
    expect(typeof result.num_turns).toBe("number");
  });

  it("uses deterministic session_id when --session-id flag is provided", async () => {
    const sessionId = "deadbeef-dead-dead-dead-deaddeadbeef";
    const { stdout } = await runMockAgent(["--profile", "error", "--session-id", sessionId]);
    const events = parseEvents(stdout) as any[];

    const init = events.find((e: any) => e.type === "system" && e.subtype === "init") as any;
    expect(init?.session_id).toBe(sessionId);

    const result = events.find((e: any) => e.type === "result") as any;
    expect(result?.session_id).toBe(sessionId);
  });

  it("init session_id and result session_id match", async () => {
    const { stdout } = await runMockAgent(["--profile", "error"]);
    const events = parseEvents(stdout) as any[];

    const init = events.find((e: any) => e.type === "system" && e.subtype === "init") as any;
    const result = events.find((e: any) => e.type === "result") as any;
    expect(init?.session_id).toBe(result?.session_id);
  });
});
