// @gate:always-run
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

// A test that seeds a Windows-style `C:/...` path writes into the checkout on Linux
// (it is a relative path there). Windows cannot check such a path out (core.protectNTFS),
// which makes the branch undeliverable (#1419). Fail on any tracked OR untracked file
// whose path has a drive-letter segment.
const DRIVE_SEGMENT = /(^|\/)[A-Za-z]:(\/|$)/;

describe("no drive-letter paths inside the repo", () => {
  it("has no tracked or untracked file with a drive-letter path segment", () => {
    const out = gitExecSync(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: resolve(import.meta.dirname, "../../../.."),
    });
    const bad = String(out).split("\0").filter((p) => DRIVE_SEGMENT.test(p));
    expect(bad).toEqual([]);
  });
});
