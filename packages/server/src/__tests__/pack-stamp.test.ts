// @gate:always-run when:scripts/pack-stamp.mjs,scripts/promote.mjs,scripts/pack-worker.mjs — imports scripts/pack-stamp.mjs, outside this package (#1404).
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error plain .mjs script
import { isPackStampDiff, restorePackStamp } from "../../../../scripts/pack-stamp.mjs";

const diff = (a: string, b: string) => `--- a/x\n+++ b/x\n@@ -3 +3 @@\n-  "version": "${a}",\n+  "version": "${b}",\n`;

describe("pack stamp recognition (#1404)", () => {
  it("accepts exactly the -dev.<sha> stamp", () => {
    expect(isPackStampDiff(diff("0.1.9", "0.1.9-dev.11dc8da40"))).toBe(true);
  });
  it("rejects other version edits and extra changes", () => {
    expect(isPackStampDiff(diff("0.1.9", "0.2.0"))).toBe(false);
    expect(isPackStampDiff(diff("0.1.9", "0.1.8-dev.abc"))).toBe(false);
    expect(isPackStampDiff(diff("0.1.9", "0.1.9-dev.abc") + '-  "a": 1\n+  "a": 2\n')).toBe(false);
  });
  it("restores a stamped file in a real checkout, leaves others alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-stamp-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir });
    g("init", "-q");
    execFileSync("mkdir", ["-p", join(dir, "packages/server")]);
    const f = join(dir, "packages/server/package.json");
    const orig = '{\n  "version": "0.1.9"\n}\n';
    writeFileSync(f, orig);
    g("add", "."); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
    writeFileSync(f, '{\n  "version": "0.1.9-dev.abc123"\n}\n');
    expect(restorePackStamp(dir)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(orig);
    writeFileSync(f, '{\n  "version": "9.9.9"\n}\n');
    expect(restorePackStamp(dir)).toBe(false);
  });
});
