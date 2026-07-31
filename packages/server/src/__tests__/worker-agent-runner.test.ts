import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { createWorkerAgentRunner } from "../worker/worker-agent-runner.js";
import type { WorkerToBoardMessage, WorkerLaunchSpec } from "@agentic-kanban/shared/lib/worker-protocol";

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined),
) as Record<string, string>;

function nodeSpec(script: string, overrides?: Partial<WorkerLaunchSpec>): WorkerLaunchSpec {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: cleanEnv,
    cwd: tmpdir(),
    stdinPrompt: "",
    ...overrides,
  };
}

function collector() {
  const messages: WorkerToBoardMessage[] = [];
  const runner = createWorkerAgentRunner((msg) => messages.push(msg));
  const eventsOf = (sessionId: string) =>
    messages.flatMap((m) => (m.type === "event" && m.event.sessionId === sessionId ? [m.event] : []));
  const exitOf = (sessionId: string) => eventsOf(sessionId).find((e) => e.type === "exit");
  return { messages, runner, eventsOf, exitOf };
}

describe("worker-agent-runner (worker fleet phase 1b)", () => {
  it("runs an agent, streams stdout, and reports exit", async () => {
    const { runner, eventsOf, exitOf } = collector();
    runner.assign("s1", nodeSpec("console.log('hello-from-worker')"));
    expect(runner.runningSessionIds()).toEqual(["s1"]);

    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
    const stdout = eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("hello-from-worker");
    expect(exitOf("s1")!.exitCode).toBe(0);
    expect(runner.runningSessionIds()).toEqual([]);
  });

  it("writes the initial prompt to stdin (write-and-close default)", async () => {
    const { runner, eventsOf, exitOf } = collector();
    const echoStdin = "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{console.log('got:'+b.trim());});";
    runner.assign("s1", nodeSpec(echoStdin, { stdinPrompt: "the-prompt" }));

    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
    const stdout = eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("");
    expect(stdout).toContain("got:the-prompt");
  });

  it("supports multi-turn: keepStdinOpen + input() + closeStdin()", async () => {
    const { runner, eventsOf, exitOf } = collector();
    const lineEcho =
      "process.stdin.setEncoding('utf8');let b='';" +
      "process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){console.log('echo:'+b.slice(0,i));b=b.slice(i+1);}});" +
      "process.stdin.on('end',()=>process.exit(0));";
    runner.assign("s1", nodeSpec(lineEcho, { stdinPrompt: "first", keepStdinOpen: true }));

    await vi.waitFor(() => {
      const out = eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("");
      expect(out).toContain("echo:first");
    }, { timeout: 15000 });

    expect(runner.input("s1", "second")).toBe(true);
    await vi.waitFor(() => {
      const out = eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("");
      expect(out).toContain("echo:second");
    }, { timeout: 15000 });

    expect(runner.closeStdin("s1")).toBe(true);
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
    expect(exitOf("s1")!.exitCode).toBe(0);
  });

  it("rejects a duplicate assignment for a running session", async () => {
    const { runner, messages, exitOf } = collector();
    runner.assign("s1", nodeSpec("setTimeout(()=>{},5000)", { keepStdinOpen: true }));
    runner.assign("s1", nodeSpec("console.log('nope')"));
    expect(messages.some((m) => m.type === "assign_failed" && m.sessionId === "s1")).toBe(true);

    runner.stop("s1");
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
  });

  it("stop() kills a long-running agent and still emits exactly one exit", async () => {
    const { runner, eventsOf, exitOf } = collector();
    runner.assign("s1", nodeSpec("setInterval(()=>{},1000)", { keepStdinOpen: true }));
    await vi.waitFor(() => expect(runner.runningSessionIds()).toEqual(["s1"]));

    expect(runner.stop("s1")).toBe(true);
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });
    expect(eventsOf("s1").filter((e) => e.type === "exit")).toHaveLength(1);
    expect(runner.runningSessionIds()).toEqual([]);
  });

  it("surfaces a spawn failure as stderr + exit instead of throwing", async () => {
    const { runner, eventsOf, exitOf, messages } = collector();
    runner.assign("s1", nodeSpec("x", { command: "definitely-not-a-real-binary-xyz" }));

    await vi.waitFor(() => {
      expect(exitOf("s1") ?? messages.find((m) => m.type === "assign_failed")).toBeTruthy();
    }, { timeout: 15000 });
    if (exitOf("s1")) {
      expect(exitOf("s1")!.exitCode).toBe(1);
      const stderr = eventsOf("s1").filter((e) => e.type === "stderr").map((e) => e.data).join("");
      expect(stderr).toContain("Process error");
    }
  });
});
