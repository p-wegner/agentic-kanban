import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildConnectRunbook } from "../lib/worker-connect-runbook.js";
import { describeRunningDaemon } from "../cli/commands/worker-doctor-running-daemon.js";

const build = (os: "windows" | "unix", extra = {}) =>
  buildConnectRunbook({
    fleetUrl: "http://10.0.0.1:3003",
    pairingToken: "tok",
    code: "abc",
    options: { os, labels: ["win", "laptop"], providers: ["claude"], boardUrls: ["http://b2:3003"], profileAlias: "default=anth", toolchainInstall: "auto", toolchainAllow: ["node", "java"], ...extra },
  });

describe("runbook (#1453)", () => {
  it("single-quotes every comma list in the Windows commands", () => {
    const md = build("windows").markdown;
    expect(md).toContain("--labels 'win,laptop'");
    expect(md).toContain("--providers claude");
    expect(md).toContain("--board 'http://10.0.0.1:3003,http://b2:3003'");
    expect(md).toContain("--toolchain-allow 'node,java'");
    expect(md).not.toMatch(/--labels win,laptop/);
  });

  it("keeps the plain form for POSIX shells", () => {
    expect(build("unix").markdown).toContain("--labels win,laptop");
  });

  it("a rendered Windows setup command re-parses as a single labels argument", () => {
    const step = build("windows").steps.find((s) => s.id === "setup-pair")!;
    const line = step.commands[0]!.replace(/^agentic-kanban-worker/, "function f { $args.Count; $args | ForEach-Object { \"[$_]\" } }; f");
    const res = spawnSync("pwsh", ["-NoProfile", "-Command", line], { encoding: "utf8" });
    if (res.error) return; // no PowerShell here: the string assertions above still pin the quoting
    expect(res.stdout).toContain("[win,laptop]");
    expect(res.stdout).toContain("[http://10.0.0.1:3003,http://b2:3003]");
  });

  it("names the auth step and the old-install retirement", () => {
    const rb = build("windows");
    expect(rb.steps.find((s) => s.id === "login")!.humanCommand).toBe("agentic-kanban-worker auth claude");
    expect(rb.markdown).not.toContain("claude /login");
    expect(rb.steps.some((s) => s.id === "retire-old-install")).toBe(true);
    expect(build("unix").steps.some((s) => s.id === "retire-old-install")).toBe(false);
  });
});

describe("running daemon check (#1453)", () => {
  it("warns when no daemon runs and passes with attested profiles shown", () => {
    expect(describeRunningDaemon(null, false).status).toBe("warn");
    const c = describeRunningDaemon({ pid: 7, profiles: ["anth"], workerVersion: "1.0" }, true);
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("attested profiles anth");
  });
});
