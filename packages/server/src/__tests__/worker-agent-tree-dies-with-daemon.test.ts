// #1336: killing the worker daemon must not leave the agent's children running as orphans.
// Windows: the kill-on-close Job Object does it live; the startup sweep is the net under it.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLeftoverPids,
  forgetAgent,
  markAgentsLeftOnPurpose,
  readAgentRecords,
  recordAgent,
  sweepLeftoverAgents,
  type AgentRecord,
} from "../worker/worker-agent-registry.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ak-1336-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}

const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  sessionId: "s1", pid: 100, cwd: "C:\\work\\checkouts\\s1", startedAt: new Date(Date.now()).toISOString(), daemonPid: 1, ...over,
});

describe("worker agent registry (#1336)", () => {
  it("round-trips records and forgets them", () => {
    const root = tmp();
    recordAgent(root, record());
    expect(readAgentRecords(root).map((r) => r.sessionId)).toEqual(["s1"]);
    forgetAgent(root, "s1");
    expect(readAgentRecords(root)).toEqual([]);
  });

  it("collects descendants of a dead agent pid and processes naming the checkout", () => {
    const procs = [
      { pid: 200, ppid: 100, name: "bash.exe", commandLine: "bash -c sleep" }, // child of dead agent 100
      { pid: 201, ppid: 200, name: "sleep.exe", commandLine: "sleep 600" },
      { pid: 300, ppid: 5, name: "node.exe", commandLine: "node C:\\work\\checkouts\\s1\\server.js" },
      { pid: 400, ppid: 5, name: "unrelated.exe", commandLine: "unrelated" },
    ];
    expect(collectLeftoverPids(record(), procs, 999).sort()).toEqual([200, 201, 300]);
  });

  it("sweep kills leftovers, logs them, and skips agents left on purpose", async () => {
    const root = tmp();
    recordAgent(root, record({ sessionId: "dead", pid: 100 }));
    recordAgent(root, record({ sessionId: "kept", pid: 500, cwd: undefined }));
    markAgentsLeftOnPurpose(root, ["kept"]);
    const killed: number[] = [];
    const lines: string[] = [];
    const report = await sweepLeftoverAgents(root, (l) => lines.push(l), {
      platform: "win32",
      ownPid: 999,
      listProcesses: async () => [{ pid: 200, ppid: 100, name: "bash.exe", commandLine: "bash" }],
      kill: async (pid) => { killed.push(pid); },
    });
    expect(killed).toEqual([200]);
    expect(report.leftOnPurpose).toEqual(["kept"]);
    expect(lines.join("\n")).toMatch(/killed leftover process.*pid=200/);
    expect(lines.join("\n")).toMatch(/left on purpose \(--leave-agents\)/);
    expect(readAgentRecords(root).map((r) => r.sessionId)).toEqual(["kept"]);
  });

  it("POSIX sweep kills the recorded process group", async () => {
    const root = tmp();
    recordAgent(root, record({ pid: 4321 }));
    const calls: Array<[number, boolean]> = [];
    await sweepLeftoverAgents(root, () => {}, { platform: "linux", ownPid: 999, kill: async (pid, group) => { calls.push([pid, group]); } });
    expect(calls).toEqual([[4321, true]]);
  });
});

describe.skipIf(process.platform !== "win32")("kill-on-close job object (#1336, Windows)", () => {
  it("the agent's child is gone after the daemon is killed", async () => {
    const dir = tmp();
    const holderUrl = pathToFileURL(join(import.meta.dirname, "..", "worker", "worker-job-holder.ts")).href;
    const tsxUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "loader.mjs")).href;
    // The "agent" starts a long-running grandchild and prints its pid, like claude starting bash.
    const agentJs = join(dir, "agent.js");
    writeFileSync(
      agentJs,
      `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
console.log("CHILD " + c.pid);
setTimeout(()=>{}, 600000);`,
    );
    const daemonMjs = join(dir, "daemon.mjs");
    writeFileSync(
      daemonMjs,
      `import { spawn } from "node:child_process";
import { attachAgentJob } from ${JSON.stringify(holderUrl)};
const agent = spawn(process.execPath, [${JSON.stringify(agentJs)}], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
const job = attachAgentJob(agent.pid, () => {});
console.log("AGENT " + agent.pid);
console.log("STATUS " + await job.ready);
agent.stdout.on("data", (d) => process.stdout.write(d));
setTimeout(()=>{}, 600000);`,
    );
    const daemon = spawn(process.execPath, ["--import", tsxUrl, daemonMjs], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let out = "";
    daemon.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const ready = await waitFor(() => /STATUS /.test(out) && /CHILD \d+/.test(out), 60_000);
    const agentPid = Number(out.match(/AGENT (\d+)/)?.[1]);
    const childPid = Number(out.match(/CHILD (\d+)/)?.[1]);
    try {
      expect(ready, out).toBe(true);
      expect(out).toMatch(/STATUS job-ready/);
      expect(alive(childPid)).toBe(true);
      process.kill(daemon.pid as number, "SIGKILL"); // Stop-Process -Force equivalent: no shutdown code runs
      expect(await waitFor(() => !alive(childPid) && !alive(agentPid), 15_000)).toBe(true);
    } finally {
      for (const pid of [childPid, agentPid]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      try { process.kill(daemon.pid as number, "SIGKILL"); } catch { /* gone */ }
    }
  }, 90_000);
});
