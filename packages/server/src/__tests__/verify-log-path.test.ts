// A train gate's verify-log key is `train:<label>` and the label holds a `/`. Used raw in the
// `%TEMP%\kanban-verify-<key>.log` path, the `:` made NTFS write the log into an ALTERNATE DATA
// STREAM of an empty file `kanban-verify-train` (measured 2026-09-27: hundreds of streams), so no
// operator or tool could find a train's log. `verifyLogPath` is the one builder; these pin it.
import { describe, expect, it } from "vitest";
import { readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { summarizeVerifyFailure, verifyLogPath } from "../services/verify-failure-summary.js";

/** Everything after a leading `C:` drive designator — the only place a `:` may legally sit. */
function afterDrive(path: string): string {
  return path.replace(/^[A-Za-z]:/, "");
}

describe("verifyLogPath", () => {
  it.each([
    "train:train/2026-09-27-06",
    "train:train/2026-09-27-06ab",
    "train:q1abc",
    "ws-1234",
    'odd<>:"/\\|?*\u0001key',
    "trailing. ",
  ])("never puts a reserved filename character into the leaf for %j", (key) => {
    const path = verifyLogPath(key, "C:\\Users\\x\\AppData\\Local\\Temp");
    expect(afterDrive(path)).not.toContain(":");
    const leaf = basename(path);
    expect(leaf.startsWith("kanban-verify-")).toBe(true);
    expect(leaf.endsWith(".log")).toBe(true);
    // eslint-disable-next-line no-control-regex -- control characters are part of the reserved set
    expect(leaf).not.toMatch(/[<>:"/\\|?*\u0000-\u001f]/);
  });

  it("leaves an ordinary workspace id unchanged, so existing log names keep working", () => {
    expect(basename(verifyLogPath("3f2a9c1e-ws"))).toBe("kanban-verify-3f2a9c1e-ws.log");
  });

  it("the DEFAULT writer puts a train's log in a real, findable file (not an NTFS stream)", () => {
    const key = `train:train/2099-01-01-${process.pid}`;
    const expected = verifyLogPath(key);
    try {
      const summary = summarizeVerifyFailure("FAIL x\n Test Files  1 failed (1)", "", key);
      expect(summary).toContain(`[full verify log: ${expected}]`);
      expect(afterDrive(expected)).not.toContain(":");
      expect(basename(expected)).toBe(`kanban-verify-train-train-2099-01-01-${process.pid}.log`);
      // A plain file with a colon-free leaf, so a directory listing shows it (a stream never is).
      expect(statSync(expected).isFile()).toBe(true);
      expect(readFileSync(expected, "utf8")).toContain("FAIL x");
    } finally {
      rmSync(expected, { force: true });
    }
  });
});
