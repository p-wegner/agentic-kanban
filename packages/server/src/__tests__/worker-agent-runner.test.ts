import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { createWorkerAgentRunner, ASSIGN_REFUSED_AT_CAPACITY } from "../worker/worker-agent-runner.js";
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

function collector(options?: { maxConcurrency?: number }) {
  const messages: WorkerToBoardMessage[] = [];
  const runner = createWorkerAgentRunner((msg) => messages.push(msg), options);
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

describe("worker hang watchdog (parity with the host spawn site)", () => {
  it("kills an agent that produces no output at all", async () => {
    const { runner, eventsOf, exitOf } = collector();
    // Silent forever: keepStdinOpen so it never sees EOF and never prints.
    runner.assign("s1", nodeSpec("setInterval(()=>{},1000)", { keepStdinOpen: true, hangTimeoutMs: 1500 }));

    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 20000 });
    const stderr = eventsOf("s1").filter((e) => e.type === "stderr").map((e) => e.data).join("");
    expect(stderr).toContain("hang watchdog");
    expect(runner.runningSessionIds()).toEqual([]);
  }, 30000);

  it("does NOT kill an agent that keeps producing output", async () => {
    const { runner, eventsOf, exitOf } = collector();
    // Prints every 100ms for ~5s — each byte must reset a 2.5s watchdog (#620).
    //
    // The two numbers are constrained from BOTH sides and neither may be tuned alone:
    //   - output interval << timeout, or a scheduling stall under full-suite parallel load
    //     lets a CORRECTLY-working watchdog fire and the assertion fails. This was the flake:
    //     200ms ticks against a 1s timeout is only a 5x margin, and a >1s stall between two
    //     child-process ticks is entirely plausible with 16 vitest workers running. 100ms
    //     against 2.5s is 25x.
    //   - timeout << total run duration, or the test goes VACUOUS: if reset() were broken,
    //     the watchdog would fire at 2.5s, and it only proves anything because the process
    //     keeps running to ~5s. The `tick50` assertion below is what pins that duration, so
    //     raising hangTimeoutMs above ~5s would silently turn this test green-for-free.
    const chatty =
      "let n=0;const t=setInterval(()=>{console.log('tick'+(++n));if(n>=50){clearInterval(t);process.exit(0);}},100);";
    runner.assign("s1", nodeSpec(chatty, { keepStdinOpen: true, hangTimeoutMs: 2500 }));

    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 25000 });
    const stderr = eventsOf("s1").filter((e) => e.type === "stderr").map((e) => e.data).join("");
    expect(stderr).not.toContain("hang watchdog");
    // Survived to a clean, self-chosen exit rather than being killed mid-run.
    expect(exitOf("s1")!.exitCode).toBe(0);
    const stdout = eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("");
    // Load-bearing for non-vacuity: reaching tick50 means the process ran ~5s, i.e. well
    // past the 2.5s watchdog, so a broken reset() could not have escaped detection.
    expect(stdout).toContain("tick50");
  }, 35000);

  it("is disabled when the board sends hangTimeoutMs=0 (mock agents)", async () => {
    const { runner, eventsOf, exitOf } = collector();
    runner.assign("s1", nodeSpec("setTimeout(()=>{console.log('late');process.exit(0);},2500)", {
      keepStdinOpen: true,
      hangTimeoutMs: 0,
    }));

    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 25000 });
    const stderr = eventsOf("s1").filter((e) => e.type === "stderr").map((e) => e.data).join("");
    expect(stderr).not.toContain("hang watchdog");
    expect(eventsOf("s1").filter((e) => e.type === "stdout").map((e) => e.data).join("")).toContain("late");
  }, 35000);
});

// #266 — the worker enforces its OWN declared ceiling. The board tracks capacity too
  // (#248), but that only protects against a well-behaved board; the whole point of
  // declaring capacity is that the machine's owner controls its load.
describe("maxConcurrency (worker-side enforcement, #266)", () => {
  const stayAlive = "setInterval(()=>{},1000)";

  it("refuses a second concurrent assign when maxConcurrency=1", async () => {
    const { messages, runner } = collector({ maxConcurrency: 1 });
    runner.assign("s1", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));
    expect(runner.runningSessionIds()).toEqual(["s1"]);

    runner.assign("s2", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));

    const refusal = messages.find((m) => m.type === "assign_failed" && m.sessionId === "s2");
    expect(refusal).toBeTruthy();
    // Distinguishable from a launch failure so the board can place elsewhere
    // and release its pending slot, rather than recording a broken session.
    expect(refusal).toMatchObject({ error: ASSIGN_REFUSED_AT_CAPACITY });
    // Crucially: it was refused, not silently run.
    expect(runner.runningSessionIds()).toEqual(["s1"]);

    runner.stopAll();
  });

  it("accepts a later assign once the slot is free again", async () => {
    const { messages, runner, exitOf } = collector({ maxConcurrency: 1 });
    runner.assign("s1", nodeSpec("process.exit(0)"));
    await vi.waitFor(() => expect(exitOf("s1")).toBeTruthy(), { timeout: 15000 });

    runner.assign("s2", nodeSpec("console.log('second-ran')"));
    await vi.waitFor(() => expect(exitOf("s2")).toBeTruthy(), { timeout: 15000 });

    expect(messages.find((m) => m.type === "assign_failed" && m.sessionId === "s2")).toBeUndefined();
  }, 35000);

  it("allows concurrent sessions up to the declared ceiling", async () => {
    const { messages, runner } = collector({ maxConcurrency: 2 });
    runner.assign("s1", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));
    runner.assign("s2", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));
    expect(runner.runningSessionIds().sort()).toEqual(["s1", "s2"]);

    runner.assign("s3", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));
    expect(messages.find((m) => m.type === "assign_failed" && m.sessionId === "s3"))
      .toMatchObject({ error: ASSIGN_REFUSED_AT_CAPACITY });
    expect(runner.runningSessionIds().sort()).toEqual(["s1", "s2"]);

    runner.stopAll();
  });

  it("defaults to 1 when the worker declared no ceiling", () => {
    const { messages, runner } = collector();
    runner.assign("s1", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));
    runner.assign("s2", nodeSpec(stayAlive, { keepStdinOpen: true, hangTimeoutMs: 0 }));

    expect(messages.find((m) => m.type === "assign_failed" && m.sessionId === "s2"))
      .toMatchObject({ error: ASSIGN_REFUSED_AT_CAPACITY });
    runner.stopAll();
  });
});
