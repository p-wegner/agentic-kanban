// #1371: install-on-request — the policy matrix, the board's request logic, the frame round trip and the
// worker's installer against a fake mise.
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideToolchainInstall,
  miseSpecFor,
  parseToolchainAllowList,
  type WorkerToolchainInstallInfo,
} from "@agentic-kanban/shared/lib/worker-toolchain-install";
import { parseRequiredToolchains, toolchainRequirementLabels, type WorkerToolchains } from "@agentic-kanban/shared/lib/worker-toolchains";
import {
  parseBoardToWorkerMessage,
  parseWorkerCapabilities,
  parseWorkerToBoardMessage,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { requestToolchainInstalls, describeInstallOutlook, TOOLCHAIN_INSTALL_RETRY_MS } from "../services/toolchain-install.service.js";
import type { WorkerView } from "../services/worker-registry.service.js";
import { approveToolchainRequest, createToolchainInstaller, readPendingRequests, type RunFn } from "../worker/worker-toolchain-install.js";

const NEED_GO = parseRequiredToolchains("go>=1.23");
const info = (policy: WorkerToolchainInstallInfo["policy"], allow: string[] = [], mise = true): WorkerToolchainInstallInfo => ({ policy, allow, mise });

describe("policy matrix (#1371)", () => {
  it("never: blocked, and the reason names the policy", () => {
    const d = decideToolchainInstall(info("never"), NEED_GO);
    expect(d.action).toBe("blocked");
    expect(d.action === "blocked" && d.reason).toContain('"never"');
  });
  it("a worker that declares nothing (older build) reads as never", () => {
    expect(decideToolchainInstall(undefined, NEED_GO).action).toBe("blocked");
  });
  it("no mise: blocked with no winget/apt fallback", () => {
    const d = decideToolchainInstall(info("auto", ["go"], false), NEED_GO);
    expect(d.action === "blocked" && d.reason).toMatch(/mise is not installed.*no fallback to winget\/apt/);
  });
  it("ask: waits for approval", () => {
    expect(decideToolchainInstall(info("ask"), NEED_GO).action).toBe("await-approval");
  });
  it("auto: installs only when every toolchain is allowlisted", () => {
    expect(decideToolchainInstall(info("auto", ["go"]), NEED_GO).action).toBe("install");
    const d = decideToolchainInstall(info("auto", ["go"]), parseRequiredToolchains("go, java>=21"));
    expect(d.action === "blocked" && d.reason).toContain("java");
    expect(decideToolchainInstall(info("auto", []), NEED_GO).action).toBe("blocked");
  });
  it("docker is never installable", () => {
    expect(decideToolchainInstall(info("auto", ["docker"]), parseRequiredToolchains("docker")).action).toBe("blocked");
  });
  it("maps requirements to mise specs", () => {
    expect(miseSpecFor({ name: "go", minVersion: "1.23" })).toBe("go@1.23");
    expect(miseSpecFor({ name: "uv" })).toBe("uv@latest");
    expect(miseSpecFor({ name: "docker" })).toBeNull();
    expect(parseToolchainAllowList("Java, go,,GO")).toEqual(["java", "go"]);
  });
});

describe("frames (#1371)", () => {
  it("the request frame round-trips without a sessionId", () => {
    const frame = { type: "toolchain_install", requestId: "r1", toolchains: ["go>=1.23"] };
    expect(parseBoardToWorkerMessage(JSON.stringify(frame))).toEqual(frame);
    expect(parseBoardToWorkerMessage(JSON.stringify({ ...frame, toolchains: [] }))).toBeNull();
    expect(parseBoardToWorkerMessage(JSON.stringify({ ...frame, requestId: "" }))).toBeNull();
  });
  it("the status frame round-trips and rejects a bad state", () => {
    const frame = { type: "toolchain_install_status", status: { requestId: "r1", state: "failed", toolchains: ["go"], reason: "boom" } };
    expect(parseWorkerToBoardMessage(JSON.stringify(frame))).toEqual(frame);
    expect(parseWorkerToBoardMessage(JSON.stringify({ ...frame, status: { ...frame.status, state: "weird" } }))).toBeNull();
  });
  it("capabilities carry the declared policy", () => {
    expect(parseWorkerCapabilities({ toolchainInstall: { policy: "auto", allow: ["Go"], mise: true } })?.toolchainInstall).toEqual(info("auto", ["go"]));
    expect(parseWorkerCapabilities({ toolchainInstall: { policy: "yolo" } })).toBeUndefined();
  });
});

function view(over: Partial<WorkerView> & { id: string }): WorkerView {
  return { name: over.id, toolchains: { node: "22.1.0" }, ...over } as WorkerView;
}

describe("board request logic (#1371)", () => {
  const reqs = toolchainRequirementLabels(NEED_GO);
  function harness(reachable = true) {
    const sent: Array<{ id: string; frame: { requestId: string; toolchains: string[] } }> = [];
    const recorded: string[] = [];
    return {
      sent, recorded,
      deps: {
        send: (id: string, frame: { type: "toolchain_install"; requestId: string; toolchains: string[] }) => { sent.push({ id, frame }); return true; },
        record: (id: string, requestId: string) => { recorded.push(`${id}:${requestId}`); },
        reachable: () => reachable,
        nowMs: 1_000_000,
      },
    };
  }

  it("auto + allowlist: asks, and does not ask twice while it is in flight", () => {
    const h = harness();
    const w = view({ id: "w1", toolchainInstallPolicy: info("auto", ["go"]) });
    const out = requestToolchainInstalls([w], reqs, h.deps);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.frame.toolchains).toEqual(["go>=1.23"]);
    expect(out.active).toEqual({ workerId: "w1", state: "pending" });
    const again = requestToolchainInstalls(
      [{ ...w, toolchainInstall: { requestId: "x", toolchains: ["go>=1.23"], state: "installing", requestedAtMs: 1, updatedAtMs: 1 } }],
      reqs, h.deps,
    );
    expect(h.sent).toHaveLength(1);
    expect(again.active?.state).toBe("installing");
  });

  it("never: no frame, and the blocked reason names the policy", () => {
    const h = harness();
    const out = requestToolchainInstalls([view({ id: "w1", toolchainInstallPolicy: info("never") })], reqs, h.deps);
    expect(h.sent).toHaveLength(0);
    expect(out.blocked[0]!.reason).toContain('"never"');
  });

  it("ask: the frame is sent (the worker shows it as pending until approved)", () => {
    const h = harness();
    requestToolchainInstalls([view({ id: "w1", toolchainInstallPolicy: info("ask") })], reqs, h.deps);
    expect(h.sent).toHaveLength(1);
  });

  it("a recent failure blocks with its reason, an old one is retried", () => {
    const failed = { requestId: "x", toolchains: ["go>=1.23"], state: "failed" as const, reason: "disk full", requestedAtMs: 1, updatedAtMs: 999_000 };
    const h = harness();
    const w = view({ id: "w1", toolchainInstallPolicy: info("auto", ["go"]), toolchainInstall: failed });
    const out = requestToolchainInstalls([w], reqs, h.deps);
    expect(out.blocked[0]!.reason).toContain("disk full");
    expect(h.sent).toHaveLength(0);
    requestToolchainInstalls([w], reqs, { ...h.deps, nowMs: 999_000 + TOOLCHAIN_INSTALL_RETRY_MS + 1 });
    expect(h.sent).toHaveLength(1);
  });

  it("skips workers that already have it, that said nothing, or are unreachable", () => {
    const h = harness();
    requestToolchainInstalls([view({ id: "a", toolchains: { go: "1.23.1" }, toolchainInstallPolicy: info("auto", ["go"]) })], reqs, h.deps);
    requestToolchainInstalls([view({ id: "b", toolchains: undefined, toolchainInstallPolicy: info("auto", ["go"]) })], reqs, h.deps);
    requestToolchainInstalls([view({ id: "c", toolchainInstallPolicy: info("auto", ["go"]) })], reqs, harness(false).deps);
    expect(h.sent).toHaveLength(0);
  });

  it("explains the outlook in placement text", () => {
    expect(describeInstallOutlook({ toolchainInstallPolicy: info("never") }, ["go>=1.23"])).toContain("cannot install");
    expect(describeInstallOutlook({ toolchainInstallPolicy: info("ask") }, ["go>=1.23"])).toContain("approval");
    expect(describeInstallOutlook({ toolchainInstallPolicy: info("auto", ["go"]), toolchainInstall: { requestId: "r", toolchains: [], state: "failed", reason: "x", requestedAtMs: 0, updatedAtMs: 0 } }, ["go"])).toContain("install failed: x");
  });
});

describe("worker installer with a fake mise (#1371)", () => {
  function setup(policy: "never" | "ask" | "auto", allow: string[], opts: { mise?: boolean; failInstall?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ak-tc-"));
    const stateFile = join(dir, "worker-state.json");
    const sent: WorkerToBoardMessage[] = [];
    const calls: string[] = [];
    let have: WorkerToolchains = { node: "22.1.0" };
    const run: RunFn = async (cmd, args, env) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (args[0] === "--version") return { code: opts.mise === false ? null : 0, output: "2024.9.0" };
      if (opts.failInstall) return { code: 1, output: "download failed\nno such version" };
      expect(env.MISE_DATA_DIR).toContain("mise-data"); // worker-owned, not machine-global
      have = { ...have, go: "1.23.2" };
      return { code: 0, output: "" };
    };
    const installer = createToolchainInstaller({
      policy, allow, stateFile, run, log: () => {}, env: { PATH: "" },
      sendToBoard: (m) => sent.push(m),
      redetect: async () => have,
    });
    const states = () => sent.flatMap((m) => (m.type === "toolchain_install_status" ? [m.status.state] : []));
    return { installer, stateFile, sent, calls, states };
  }

  it("auto + allowlist: installs via mise, re-detects and reports done", async () => {
    const t = setup("auto", ["go"]);
    await t.installer.handleRequest("r1", ["go>=1.23"]);
    expect(t.calls).toContain("mise use -g go@1.23");
    expect(t.states()).toEqual(["installing", "done"]);
  });

  it("never: refuses, naming the policy, and runs nothing", async () => {
    const t = setup("never", []);
    await t.installer.handleRequest("r1", ["go>=1.23"]);
    expect(t.calls.some((c) => c.startsWith("mise use"))).toBe(false);
    const last = t.sent.at(-1);
    expect(last?.type === "toolchain_install_status" && last.status.reason).toContain('"never"');
  });

  it("auto: a toolchain off the allowlist is refused whole", async () => {
    const t = setup("auto", ["go"]);
    await t.installer.handleRequest("r1", ["go>=1.23", "java>=21"]);
    expect(t.states()).toEqual(["failed"]);
    expect(t.calls.some((c) => c.startsWith("mise use"))).toBe(false);
  });

  it("no mise: failed with the reason, no install", async () => {
    const t = setup("auto", ["go"], { mise: false });
    await t.installer.handleRequest("r1", ["go>=1.23"]);
    const last = t.sent.at(-1);
    expect(last?.type === "toolchain_install_status" && last.status.reason).toContain("mise is not installed");
  });

  it("mise failure surfaces its reason", async () => {
    const t = setup("auto", ["go"], { failInstall: true });
    await t.installer.handleRequest("r1", ["go>=1.23"]);
    expect(t.states()).toEqual(["installing", "failed"]);
    const last = t.sent.at(-1);
    expect(last?.type === "toolchain_install_status" && last.status.reason).toContain("no such version");
  });

  it("ask: pending until `toolchain approve`, then installs", async () => {
    const t = setup("ask", []);
    await t.installer.handleRequest("req-abc", ["go>=1.23"]);
    expect(t.states()).toEqual(["pending"]);
    expect(readPendingRequests(t.stateFile).map((p) => p.id)).toEqual(["req-abc"]);
    await t.installer.pollApprovals();
    expect(t.calls.some((c) => c.startsWith("mise use"))).toBe(false); // not approved yet
    expect(approveToolchainRequest(t.stateFile, "nope")).toBe(false);
    expect(approveToolchainRequest(t.stateFile, "req-abc")).toBe(true);
    await t.installer.pollApprovals();
    expect(t.states()).toEqual(["pending", "installing", "done"]);
    expect(readPendingRequests(t.stateFile)).toEqual([]);
    expect(existsSync(t.stateFile)).toBe(false); // the installer never touches the state file itself
  });

  it("frame round trip: request in, status frames out, parsed by the board", async () => {
    const t = setup("auto", ["go"]);
    const req = parseBoardToWorkerMessage(JSON.stringify({ type: "toolchain_install", requestId: "r9", toolchains: ["go>=1.23"] }));
    expect(req?.type).toBe("toolchain_install");
    if (req?.type === "toolchain_install") await t.installer.handleRequest(req.requestId, req.toolchains);
    const parsed = t.sent.map((m) => parseWorkerToBoardMessage(JSON.stringify(m)));
    expect(parsed.map((m) => (m?.type === "toolchain_install_status" ? m.status.state : null))).toEqual(["installing", "done"]);
  });
});
