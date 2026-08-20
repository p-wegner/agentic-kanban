// @gate:always-run — scans every `lib/*-exec.ts` adapter in the shared tree.
/**
 * #591 — `exec adapter` is a named kind with ONE result shape.
 *
 * `lib/<system>-exec.ts` wraps exactly one external CLI: `<system>Exec(args, opts)` +
 * `<system>Available()`, centralising `windowsHide`, buffer limits, timeouts and error
 * normalisation so the CLI is a single replaceable port. Three exist (git, docker,
 * devcontainer) and they had drifted on the one thing every caller reads: git reported a spawn
 * failure as `code: null` + `Error`, docker and devcontainer as `code: -1` + a message string.
 *
 * `-1` is a value a process can legitimately be reported as exiting with, so "did this run at
 * all?" could not be asked the same way of two adapters; `null` is the only value it can never
 * be. This pins the convention structurally (the aliases must stay assignable to `ExecResult`)
 * and behaviourally (a failed spawn yields `code: null`).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerExec } from "../src/lib/docker-exec.js";
import { devcontainerExec } from "../src/lib/devcontainer-exec.js";
import { execErrorMessage, execSucceeded, execFailedToRun, type ExecResult } from "../src/lib/exec-result.js";

const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "lib");

describe("exec adapters share one result shape (#591)", () => {
  it("every `<system>-exec.ts` adapter declares its result as the shared ExecResult", () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(libDir)) {
      if (!/-exec\.ts$/.test(name)) continue;
      const source = fs.readFileSync(path.join(libDir, name), "utf-8");
      const declaresOwnShape = /export interface \w*ExecResult \{[^}]*\bcode:/.test(source);
      const usesShared = /ExecResult\b/.test(source) && /exec-result\.js/.test(source);
      if (declaresOwnShape || !usesShared) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("no adapter reports a spawn failure as the `-1` exit code any more", () => {
    const offenders: string[] = [];
    for (const name of fs.readdirSync(libDir)) {
      if (!/-exec\.ts$/.test(name)) continue;
      const source = fs.readFileSync(path.join(libDir, name), "utf-8");
      if (/:\s*-1\b/.test(source) || /\?\s*rawCode\s*:\s*-1/.test(source)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("a missing binary yields code null, not -1, from docker and devcontainer alike", async () => {
    const results = await Promise.all([
      dockerExec(["--version"], { env: { PATH: "" }, timeoutMs: 10_000 }),
      devcontainerExec(["--version"], { env: { PATH: "" }, timeoutMs: 10_000 }),
    ]);
    for (const result of results) {
      expect(result.code === null || result.code !== 0).toBe(true);
      expect(execSucceeded(result)).toBe(false);
      expect(execErrorMessage(result)).not.toBe("");
    }
  });

  it("the predicates read the convention rather than each caller re-deriving it", () => {
    const spawned: ExecResult = { stdout: "", stderr: "", code: 0, error: null };
    const failed: ExecResult = { stdout: "", stderr: "", code: null, error: new Error("ENOENT") };
    const nonZero: ExecResult = { stdout: "", stderr: "boom", code: 2, error: new Error("exited 2") };

    expect([execSucceeded(spawned), execFailedToRun(spawned)]).toEqual([true, false]);
    expect([execSucceeded(failed), execFailedToRun(failed)]).toEqual([false, true]);
    expect([execSucceeded(nonZero), execFailedToRun(nonZero)]).toEqual([false, false]);
    // stderr wins over the wrapper's own message: the CLI that complained explains it better.
    expect(execErrorMessage(nonZero)).toBe("boom");
    expect(execErrorMessage(failed)).toBe("ENOENT");
    expect(execErrorMessage(spawned)).toBe("exit 0");
  });
});
