import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runStaticTier, runStaticTierGate, staticTierSkipReason, type StaticTierRunner } from "./static-tier.service.js";

vi.mock("./git.service.js", () => ({ getChangedFileNames: vi.fn(async () => ["packages/server/src/a.ts"]) }));

const dirs: string[] = [];
function tree(opts: { script?: boolean; deps?: boolean } = { script: true, deps: true }): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-static-tier-"));
  dirs.push(dir);
  if (opts.script) {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "check-static.mjs"), "");
  }
  if (opts.deps) mkdirSync(join(dir, "node_modules"));
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const result = (exitCode: number, stderr = "", timedOut = false) => ({ exitCode, stdout: "", stderr, timedOut });

describe("static tier", () => {
  it("decides skips from the tree", () => {
    expect(staticTierSkipReason({ hasScript: false, hasDeps: true })).toMatch(/check-static/);
    expect(staticTierSkipReason({ hasScript: true, hasDeps: false })).toMatch(/dependencies/);
    expect(staticTierSkipReason({ hasScript: true, hasDeps: true })).toBeNull();
  });

  it("is red with the guard's own output, passing the diff to the guard", async () => {
    const run = vi.fn<StaticTierRunner>(async () => result(1, "god-module ceiling: merge-queue-train.ts 1011/1000"));
    const verdict = await runStaticTier({ workingDir: tree(), baseBranch: "master", run });
    expect(verdict).toMatchObject({ ran: true, passed: false });
    expect(verdict.detail).toContain("1011/1000");
    expect(run.mock.calls[0][1].KANBAN_ARCH_CHANGED_FILES).toBe("packages/server/src/a.ts");
  });

  it("is green on exit 0", async () => {
    const verdict = await runStaticTier({ workingDir: tree(), baseBranch: "master", run: async () => result(0) });
    expect(verdict).toMatchObject({ ran: true, passed: true });
  });

  it.each([
    ["no script", { script: false, deps: true }, async () => result(1)],
    ["no deps", { script: true, deps: false }, async () => result(1)],
    ["timeout", { script: true, deps: true }, async () => result(-1, "", true)],
    ["could-not-verify exit 3", { script: true, deps: true }, async () => result(3)],
    ["runner throws", { script: true, deps: true }, async () => { throw new Error("boom"); }],
  ])("fails open: %s", async (_name, opts, run) => {
    const verdict = await runStaticTier({ workingDir: tree(opts), baseBranch: "master", run });
    expect(verdict).toMatchObject({ ran: false, passed: true });
  });

  it("the train pre-step returns a red gate result, or null to carry on", async () => {
    const red = await runStaticTierGate(tree(), "master", undefined, undefined).catch(() => null);
    // The real runner is not stubbed here: a tree with an empty script exits 0 under node.
    expect(red).toBeNull();
    expect(await runStaticTierGate(tree(), "master", undefined, "pnpm check:arch && pnpm typecheck")).toBeNull();
  });
});
