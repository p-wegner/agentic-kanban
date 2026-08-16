// @gate:always-run — scans the service/startup source tree, so its subject is not in its own import graph.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// #576: the devcontainer + its dependency volumes are a per-workspace resource with the
// SAME lifetime as the compose stack — both are keyed by the worktree path, and both
// become unreachable once `workingDir` is nulled or the worktree is removed. Five of the
// eight terminal paths tore the stack down and left the container running.
//
// Rather than re-list the eight sites (a list that drifts — that is how the five got
// missed), this asserts the INVARIANT that made them findable: any module that tears a
// stack down at a terminal path must also reap the container.

const SRC = path.resolve(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("container reap covers every stack-teardown site (#576)", () => {
  it("every module that calls teardownWorkspaceServices also calls reapWorkspaceContainer", () => {
    const offenders = tsFiles(SRC)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        // The service that DEFINES teardown is not a caller; skip it by requiring the
        // qualified call form the call sites all use.
        return text.includes("teardownWorkspaceServices({") && !text.includes("reapWorkspaceContainer(");
      })
      .map((file) => path.relative(SRC, file).replaceAll("\\", "/"));

    expect(offenders, `these tear down a stack but leak the devcontainer:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("finds the known call sites, so the scan itself cannot silently match nothing", () => {
    const callers = tsFiles(SRC).filter((file) => readFileSync(file, "utf8").includes("teardownWorkspaceServices({"));
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });
});
