// #1372 — a fresh WSL worker: the board comes from the pairing, the name cannot collide with the
// host, a worker with no usable provider says so, and its build names itself.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkerBoard } from "../cli/commands/worker-board-default.js";
import { checkWorkerBuild } from "../cli/commands/worker-doctor-build-check.js";
import { launcherCommand, useLauncherInRemedies } from "../cli/commands/worker-update-notes.js";
import { defaultWorkerName } from "../worker/worker-name.js";
import { noUsableProviderNotice, shortProviderReason } from "../worker/worker-provider-notice.js";
import { parseWorkerCapabilities } from "@agentic-kanban/shared/lib/worker-protocol";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ak-1372-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stateWith(boards: string[]): string {
  const file = join(dir, "worker-state.json");
  const entries = Object.fromEntries(boards.map((b, i) => [b, { workerId: `w${i}`, workerToken: `t${i}`, name: "n" }]));
  writeFileSync(file, JSON.stringify({ boards: entries }));
  return file;
}

describe("board default from the state file (#1372 items 1, 5)", () => {
  it("uses the only saved pairing and says so", () => {
    const file = stateWith(["http://100.105.24.76:3103"]);
    const c = resolveWorkerBoard(file, undefined);
    expect(c).toMatchObject({ ok: true, board: "http://100.105.24.76:3103", source: "state" });
    expect(c.ok && c.note).toContain("100.105.24.76:3103");
  });

  it("an explicit --board always wins", () => {
    const file = stateWith(["http://100.105.24.76:3103"]);
    expect(resolveWorkerBoard(file, "http://x:1/")).toMatchObject({ ok: true, board: "http://x:1", source: "flag" });
  });

  it("with several pairings lists them and asks for --board", () => {
    const file = stateWith(["http://a:1", "http://b:2"]);
    const c = resolveWorkerBoard(file, undefined);
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).toContain("http://a:1");
    expect(!c.ok && c.error).toContain("http://b:2");
    expect(!c.ok && c.error).toContain("--board");
  });

  it("with no pairing falls back to the local default", () => {
    expect(resolveWorkerBoard(join(dir, "missing.json"), undefined)).toMatchObject({
      ok: true,
      board: "http://127.0.0.1:3001",
      source: "default",
    });
  });
});

describe("default worker name (#1372 item 2)", () => {
  const base = { hostname: "AO-PF69VL7N", env: {}, platform: "linux" as const };
  it("is the hostname off WSL", () => {
    expect(defaultWorkerName({ ...base, osRelease: "6.8.0-generic" })).toBe("AO-PF69VL7N");
    expect(defaultWorkerName({ ...base, platform: "win32", osRelease: null })).toBe("AO-PF69VL7N");
  });
  it("carries the distro under WSL (WSL_DISTRO_NAME)", () => {
    expect(defaultWorkerName({ ...base, osRelease: "x", env: { WSL_DISTRO_NAME: "Ubuntu-24.04" } })).toBe(
      "AO-PF69VL7N-wsl-ubuntu-24-04",
    );
  });
  it("detects WSL from the kernel string when the env var is missing", () => {
    expect(defaultWorkerName({ ...base, osRelease: "5.15.167.4-microsoft-standard-WSL2" })).toBe("AO-PF69VL7N-wsl");
  });
});

describe("no usable provider (#1372 item 3)", () => {
  it("names the excluded provider and what to run", () => {
    const n = noUsableProviderNotice(["claude"], [], [{ provider: "claude", reason: "not installed" }]);
    expect(n).toContain("this worker advertises no usable provider (claude: not installed)");
    expect(n).toContain("it will receive no work");
    expect(n).toContain("agentic-kanban-worker setup");
  });
  it("is silent when something attested, or nothing was declared", () => {
    expect(noUsableProviderNotice(["claude", "codex"], ["codex"], [])).toBeUndefined();
    expect(noUsableProviderNotice(undefined, undefined, [])).toBeUndefined();
  });
  it("classifies a missing CLI vs a missing login", () => {
    expect(shortProviderReason([{ name: "claude CLI installed", status: "fail", detail: "" }])).toBe("not installed");
    expect(shortProviderReason([{ name: "claude logged in", status: "unknown", detail: "" }])).toBe("not logged in");
  });
  it("rides the capabilities blob to the board", () => {
    expect(parseWorkerCapabilities({ providers: [], providerNotice: " no provider " })).toMatchObject({
      providerNotice: "no provider",
    });
    expect(parseWorkerCapabilities({ labels: ["a"] })?.providerNotice).toBeUndefined();
  });
});

describe("worker build names itself (#1372 item 4)", () => {
  it("reads the build id from the install's own package version", () => {
    const check = checkWorkerBuild(join(dir, "worker-state.json"), null, "0.1.9-dev.ca65426f5");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("build ca65426f5");
    expect(check.detail).not.toContain("unknown");
  });
});

describe("remedies name the stable shim while the global launcher is stale (#1372 item 7)", () => {
  const checks = [
    { name: "claude logged in", status: "unknown" as const, detail: "d", remedy: "Log in: agentic-kanban-worker auth claude" },
    { name: "global launcher", status: "warn" as const, detail: "the global agentic-kanban-worker is build x" },
  ];
  it("uses the shim when the global is stale or absent", () => {
    for (const globalVersion of ["0.1.9-dev.2be110b39", null]) {
      const launcher = launcherCommand({ stateFile: join(dir, "s.json"), globalVersion, runningBuild: "f2adde4c2", hasShim: true });
      expect(launcher).not.toBe("agentic-kanban-worker");
      const out = useLauncherInRemedies(checks, launcher);
      expect(out[0]!.remedy).toBe(`Log in: ${launcher} auth claude`);
      expect(out[1]!.detail).toBe(checks[1]!.detail);
    }
  });
  it("keeps the bare name when the global is current, or there is no shim", () => {
    const state = join(dir, "s.json");
    expect(launcherCommand({ stateFile: state, globalVersion: "0.1.9-dev.f2adde4c2", runningBuild: "f2adde4c2", hasShim: true })).toBe(
      "agentic-kanban-worker",
    );
    expect(launcherCommand({ stateFile: state, globalVersion: null, runningBuild: "f2adde4c2", hasShim: false })).toBe(
      "agentic-kanban-worker",
    );
  });
});
