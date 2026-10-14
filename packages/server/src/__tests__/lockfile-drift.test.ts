// @gate:always-run
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeLockfileOnlyDrift } from "../services/lockfile-drift.js";
import { checkPnpmVersion, EXPECTED_PNPM_VERSION } from "../cli/commands/worker-doctor-pnpm-version.js";

describe("describeLockfileOnlyDrift (#1483)", () => {
  it("refuses a lockfile change with no manifest change, naming the reason", () => {
    expect(describeLockfileOnlyDrift(["pnpm-lock.yaml", "src/a.ts"])).toMatch(/lockfile-only drift/);
  });
  it("allows a lockfile change next to a package.json or pnpm-workspace.yaml change", () => {
    expect(describeLockfileOnlyDrift(["pnpm-lock.yaml", "packages/server/package.json"])).toBeNull();
    expect(describeLockfileOnlyDrift(["pnpm-lock.yaml", "pnpm-workspace.yaml"])).toBeNull();
  });
  it("ignores diffs without a lockfile", () => {
    expect(describeLockfileOnlyDrift(["src/a.ts"])).toBeNull();
    expect(describeLockfileOnlyDrift([])).toBeNull();
  });
});

describe("checkPnpmVersion (#1483)", () => {
  const probe = (output: string, found = true) => async () => ({ found, code: found ? 0 : null, output });
  it("passes on the pinned version, warns on another, stays silent when pnpm is absent", async () => {
    expect((await checkPnpmVersion(probe(`${EXPECTED_PNPM_VERSION}\n`)))?.status).toBe("pass");
    expect((await checkPnpmVersion(probe("9.0.0\n")))?.status).toBe("warn");
    expect(await checkPnpmVersion(probe("", false))).toBeNull();
  });
  it("tracks the root packageManager pin", () => {
    const root = JSON.parse(readFileSync(join(__dirname, "../../../../package.json"), "utf8"));
    expect(root.packageManager).toBe(`pnpm@${EXPECTED_PNPM_VERSION}`);
  });
});
