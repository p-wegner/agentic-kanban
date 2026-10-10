// #1346 — the global `agentic-kanban-worker start` hands over to the build current.json names.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DELEGATED_ENV,
  compareBuilds,
  delegatedArgv,
  resolveDelegation,
  runDelegated,
} from "../worker/worker-delegate.js";
import { entryForBuild, versionsDirFor, writePointer } from "../worker/worker-versions.js";
import { checkWorkerBuild } from "../cli/commands/worker-doctor-build-check.js";

let home: string;
let stateFile: string;
const NEW_BUILD = "2222222222222222222222222222222222222222";

function installBuildAt(buildId: string, script: string): string {
  const entry = entryForBuild(versionsDirFor(stateFile), buildId);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, script);
  return entry;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ak-delegate-"));
  stateFile = join(home, "worker.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("resolveDelegation", () => {
  it("delegates when current.json points at another installed build", () => {
    const entry = installBuildAt(NEW_BUILD, "");
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry });
    expect(resolveDelegation({ stateFile, runningEntry: join(home, "global", "bin", "worker.js"), env: {} }))
      .toEqual({ buildId: NEW_BUILD, entry });
  });

  it("does not delegate to itself, to an uninstalled build, with no pointer, or with --no-delegate", () => {
    const running = join(home, "global", "bin", "worker.js");
    expect(resolveDelegation({ stateFile, runningEntry: running, env: {} })).toBeNull();
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry: join(home, "gone", "worker.js") });
    expect(resolveDelegation({ stateFile, runningEntry: running, env: {} })).toBeNull();
    const entry = installBuildAt(NEW_BUILD, "");
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry });
    expect(resolveDelegation({ stateFile, runningEntry: entry, env: {} })).toBeNull();
    expect(resolveDelegation({ stateFile, runningEntry: running, noDelegate: true, env: {} })).toBeNull();
    expect(resolveDelegation({ stateFile, runningEntry: running, env: { [DELEGATED_ENV]: "1" } })).toBeNull();
  });
});

describe("runDelegated", () => {
  it("re-execs the current build with the same argv and mirrors its exit code", async () => {
    const out = join(home, "out.json");
    const entry = installBuildAt(
      NEW_BUILD,
      `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), delegated: process.env.${DELEGATED_ENV} })); process.exit(3);`,
    );
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry });
    const target = resolveDelegation({ stateFile, runningEntry: join(home, "global.js"), env: {} });
    expect(target).not.toBeNull();
    const lines: string[] = [];
    const code = await runDelegated(target!, ["start", "--board", "http://b:3003", "--no-delegate-not"], {
      log: (l) => lines.push(l),
    });
    expect(code).toBe(3);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      argv: ["start", "--board", "http://b:3003", "--no-delegate-not"],
      delegated: "1",
    });
    expect(lines.join("\n")).toContain("delegating to the current build");
  });

  it("strips a leading `worker` and --no-delegate from the argv", () => {
    expect(delegatedArgv(["worker", "start", "--no-delegate", "--board", "x"])).toEqual(["start", "--board", "x"]);
  });
});

describe("worker doctor build check", () => {
  it("reports global vs current build", () => {
    const running = join(home, "global.js");
    expect(checkWorkerBuild(stateFile, running).status).toBe("pass");
    const entry = installBuildAt(NEW_BUILD, "");
    writePointer(versionsDirFor(stateFile), { buildId: NEW_BUILD, entry });
    const check = checkWorkerBuild(stateFile, running);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(NEW_BUILD);
    expect(compareBuilds(stateFile, entry).differs).toBe(false);
    expect(checkWorkerBuild(stateFile, entry).status).toBe("pass");
  });
});
