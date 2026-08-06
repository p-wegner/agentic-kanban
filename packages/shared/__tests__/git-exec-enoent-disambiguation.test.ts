import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { gitExec, gitExecOrThrow } from "../src/lib/git-exec.js";

/**
 * #271: `spawn git ENOENT` used to conflate a missing WORKING DIRECTORY (repo deleted —
 * deterministic) with the git BINARY not spawning (PATH broken / process exhaustion —
 * environmental). The monitor's sibling scans mistook the second for the first on dead
 * repo paths. The adapter now names the real cause. Real spawn, no mocks — the failure
 * mode lives in child_process itself.
 */
describe("git-exec ENOENT disambiguation (#271)", () => {
  it("names the missing working directory when cwd does not exist", async () => {
    const missing = join(tmpdir(), `ak-gone-${randomUUID()}`);
    const result = await gitExec(["rev-parse", "HEAD"], { cwd: missing, timeout: 10_000 });
    expect(result.code).toBeNull();
    expect(result.error?.message).toMatch(/working directory does not exist/i);
    expect(result.error?.message).toContain(missing);
  });

  it("gitExecOrThrow propagates the disambiguated message", async () => {
    const missing = join(tmpdir(), `ak-gone-${randomUUID()}`);
    await expect(gitExecOrThrow(["rev-parse", "HEAD"], { cwd: missing, timeout: 10_000 }))
      .rejects.toThrow(/working directory does not exist/i);
  });
});
