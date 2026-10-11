// #1350 — the stable shim: after a (simulated) self-update the documented restart command starts the
// CURRENT build, even though the global install is the stale bootstrap build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGlobalLauncher } from "../cli/commands/worker-doctor-build-check.js";
import { installShim, shimCommandFor, shimDirFor } from "../worker/worker-shim.js";
import { entryForBuild, versionsDirFor, writePointer } from "../worker/worker-versions.js";

let home: string;
let stateFile: string;
const NEW_BUILD = "2222222222222222222222222222222222222222";

const script = (label: string) => `console.log("RAN:${label}:" + process.argv.slice(2).join(" "));`;

function writeEntry(file: string, label: string): string {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, script(label));
  return file;
}

const runResolver = (args: string[]) =>
  spawnSync(process.execPath, [join(shimDirFor(stateFile), "worker-shim.cjs"), ...args], { encoding: "utf8" });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ak-shim-"));
  stateFile = join(home, "worker.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("installShim", () => {
  it("writes the launcher files at the fixed <worker-home>/bin path, idempotently", () => {
    const bootstrap = writeEntry(join(home, "global", "bin", "worker.js"), "bootstrap");
    const cmd = installShim({ stateFile, fallbackEntry: bootstrap });
    expect(cmd).toBe(shimCommandFor(stateFile));
    expect(readFileSync(join(shimDirFor(stateFile), "agentic-kanban-worker.cmd"), "utf8")).toContain("worker-shim.cjs");
    expect(readFileSync(join(shimDirFor(stateFile), "agentic-kanban-worker.ps1"), "utf8")).toContain("worker-shim.cjs");
    expect(installShim({ stateFile, fallbackEntry: bootstrap })).toBe(cmd);
  });

  it("a fresh state dir (no versions/) runs the fallback build", () => {
    const bootstrap = writeEntry(join(home, "global", "bin", "worker.js"), "bootstrap");
    installShim({ stateFile, fallbackEntry: bootstrap });
    expect(runResolver(["start", "--board", "b"]).stdout).toContain("RAN:bootstrap:start --board b");
  });

  it("refuses a fallback install whose package was replaced since the shim was written (#1400)", () => {
    const root = join(home, "global");
    const bootstrap = writeEntry(join(root, "bin", "worker.js"), "bootstrap");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agentic-kanban", version: "0.1.9-dev.2be110b39" }));
    installShim({ stateFile, fallbackEntry: bootstrap, fallbackVersion: "0.1.9-dev.2be110b39" });
    expect(runResolver(["start"]).stdout).toContain("RAN:bootstrap");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agentic-kanban", version: "0.1.9-dev.acbe355e7" }));
    const r = runResolver(["start"]);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("RAN:");
    expect(r.stderr).toContain("Refusing to run a different build");
  });

  it("after a simulated self-update the restart command starts the current build", () => {
    const bootstrap = writeEntry(join(home, "global", "bin", "worker.js"), "bootstrap");
    installShim({ stateFile, fallbackEntry: bootstrap });
    const entry = writeEntry(entryForBuild(versionsDirFor(stateFile), NEW_BUILD), "current");
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry });
    expect(runResolver(["start", "--board", "b"]).stdout).toContain("RAN:current:start --board b");
  });

  it("falls back when the pointer names a build that is no longer installed", () => {
    const bootstrap = writeEntry(join(home, "global", "bin", "worker.js"), "bootstrap");
    installShim({ stateFile, fallbackEntry: bootstrap });
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry: join(home, "gone", "worker.js") });
    expect(runResolver(["start"]).stdout).toContain("RAN:bootstrap");
  });
});

describe("checkGlobalLauncher", () => {
  it("WARNs when the global launcher is an older build than the running one", () => {
    installShim({ stateFile, fallbackEntry: null });
    const check = checkGlobalLauncher({
      stateFile,
      runningEntry: null,
      globalVersion: "0.1.9-dev.6f2bd2826",
      runningVersion: "0.1.9-dev.abcdef123",
    });
    expect(check.status).toBe("warn");
    expect(check.remedy).toContain(shimCommandFor(stateFile));
  });

  it("passes when the builds match", () => {
    const check = checkGlobalLauncher({
      stateFile,
      runningEntry: null,
      globalVersion: "0.1.9-dev.abcdef123",
      runningVersion: "0.1.9-dev.abcdef123",
    });
    expect(check.status).toBe("pass");
  });
});
