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

describe("mock-agent standard profile", () => {
  it("emits init, tool_use events, assistant text, and result in order", async () => {
    const { stdout, exitCode } = await runMockAgent(["--profile", "standard"]);
    expect(exitCode).toBe(0);

    const events = parseEvents(stdout);
    expect(events.length).toBeGreaterThanOrEqual(4);

    const [first, ...rest] = events as any[];

    // First event must be system/init
    expect(first.type).toBe("system");
    expect(first.subtype).toBe("init");
    expect(first.session_id).toMatch(UUID_RE);
    expect(Array.isArray(first.tools)).toBe(true);
    expect(first.model).toBeDefined();

    // Must have at least one tool_use assistant event
    const toolEvents = rest.filter(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "tool_use"),
    );
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);

    // Tool names should include Read and Edit
    const toolNames = toolEvents.flatMap((e: any) =>
      e.message.content
        .filter((c: any) => c.type === "tool_use")
        .map((c: any) => c.name),
    );
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Edit");

    // Must have an assistant text event
    const textEvents = rest.filter(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "text"),
    );
    expect(textEvents.length).toBeGreaterThanOrEqual(1);

    // Last event must be result/success
    const last = events[events.length - 1] as any;
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("success");
    expect(last.is_error).toBe(false);
    expect(last.session_id).toMatch(UUID_RE);
    expect(typeof last.duration_ms).toBe("number");
    expect(typeof last.num_turns).toBe("number");
  });

  it("uses deterministic session_id when --session-id flag is provided", async () => {
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const { stdout, exitCode } = await runMockAgent(["--profile", "standard", "--session-id", sessionId]);
    expect(exitCode).toBe(0);

    const events = parseEvents(stdout) as any[];
    const initEvent = events.find((e) => e.type === "system" && e.subtype === "init");
    expect(initEvent?.session_id).toBe(sessionId);

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent?.session_id).toBe(sessionId);
  });

  it("logs resume id to stderr and includes Resuming text when --resume is passed", async () => {
    const resumeId = "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb";
    const { stdout, stderr, exitCode } = await runMockAgent(["--profile", "standard", "--resume", resumeId]);
    expect(exitCode).toBe(0);

    expect(stderr).toContain("resuming session");

    const events = parseEvents(stdout) as any[];
    const textEvents = events.filter(
      (e: any) =>
        e.type === "assistant" &&
        e.message?.content?.some((c: any) => c.type === "text" && c.text?.includes("Resuming session")),
    );
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("all assistant events have required message fields", async () => {
    const { stdout } = await runMockAgent(["--profile", "standard"]);
    const events = parseEvents(stdout) as any[];

    const assistantEvents = events.filter((e: any) => e.type === "assistant");
    for (const evt of assistantEvents) {
      expect(evt.message).toBeDefined();
      expect(evt.message.type).toBe("message");
      expect(evt.message.role).toBe("assistant");
      expect(Array.isArray(evt.message.content)).toBe(true);
      expect(evt.message.model).toBeDefined();
      expect(evt.message.usage).toBeDefined();
      expect(typeof evt.message.usage.input_tokens).toBe("number");
      expect(typeof evt.message.usage.output_tokens).toBe("number");
    }
  });

  it("exits with code 0", async () => {
    const { exitCode } = await runMockAgent(["--profile", "standard"]);
    expect(exitCode).toBe(0);
  });
});
