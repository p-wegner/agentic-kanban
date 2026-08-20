import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the raw `docker` argv the default compose runner passes to the adapter,
// so we can assert teardown removes locally-built images (#106).
const dockerExecMock = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
const dockerAvailableMock = vi.fn(async () => true);

vi.mock("@agentic-kanban/shared/lib/docker-exec", () => ({
  dockerExec: (...args: unknown[]) => dockerExecMock(...(args as [])),
  dockerAvailable: (...args: unknown[]) => dockerAvailableMock(...(args as [])),
}));

import { createDefaultComposeRunner } from "../services/workspace-services.service.js";

function lastDownArgs(): string[] {
  const call = dockerExecMock.mock.calls.find((c) => Array.isArray(c[0]) && (c[0] as string[]).includes("down"));
  if (!call) throw new Error("no `down` invocation captured");
  return call[0] as string[];
}

describe("default compose runner — teardown removes build-context images (#106)", () => {
  beforeEach(() => {
    dockerExecMock.mockClear();
    dockerAvailableMock.mockClear();
  });

  it("full teardown (down -v) passes --rmi local so locally-built images don't leak", async () => {
    const runner = createDefaultComposeRunner();
    await runner.down({ projectName: "ak-inst1234-ws-abcdef012345", cwd: "C:/wt" });
    const args = lastDownArgs();
    expect(args).toContain("-v");
    // `--rmi local` immediately following each other, and only removes auto-tagged
    // (build:) images — pull-based images keep their custom `image:` name and survive.
    const rmiIdx = args.indexOf("--rmi");
    expect(rmiIdx).toBeGreaterThan(-1);
    expect(args[rmiIdx + 1]).toBe("local");
    expect(args).toContain("--remove-orphans");
  });

  it("volume-preserving stop (removeVolumes:false) keeps images for a fast restart — no --rmi", async () => {
    const runner = createDefaultComposeRunner();
    await runner.down({ projectName: "ak-inst1234-ws-abcdef012345", cwd: "C:/wt", removeVolumes: false });
    const args = lastDownArgs();
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--rmi");
    expect(args).toContain("--remove-orphans");
  });
});
