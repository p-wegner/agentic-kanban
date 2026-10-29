import { describe, expect, it } from "vitest";
import { workerBelowDiskFloor, MIN_FREE_DISK_GB_BUILDER } from "@agentic-kanban/shared/lib/worker-settings";
import { acceptWorkerVerdict, isDiskFullLog } from "../services/verify-placement.js";
import { checkFreeDisk } from "../cli/commands/worker-doctor-disk.js";
import { isDiskEmergency } from "./helpers/reap-fixture-child-servers.js";

describe("#1768 disk floor", () => {
  it("skips a worker under the verify floor, keeps a lower builder floor, ignores unknown", () => {
    expect(workerBelowDiskFloor(4.22).below).toBe(true);
    expect(workerBelowDiskFloor(4.22, MIN_FREE_DISK_GB_BUILDER).below).toBe(false);
    expect(workerBelowDiskFloor(undefined).below).toBe(false);
    expect(workerBelowDiskFloor(50).below).toBe(false);
  });
  it("recognises disk-full output", () => {
    expect(isDiskFullLog("SqliteError: SQLITE_FULL: database or disk is full")).toBe(true);
    expect(isDiskFullLog("Error: ENOSPC: no space left")).toBe(true);
    expect(isDiskFullLog("AssertionError: expected 1 to be 2")).toBe(false);
  });
  it("a refused infra report is never accepted as a verdict", () => {
    const r = acceptWorkerVerdict(
      { requestId: "r", workerId: "w", sha: "abc", tier: "t" },
      { requestId: "r", workerId: "w", sha: "abc", tier: "t", passed: false, refused: "infra_disk_full", reason: "disk" },
      new Set(["w"]), "w",
    );
    expect(r.accepted).toBe(false);
  });
  it("doctor shows a disk row", () => {
    expect(checkFreeDisk("/x", () => 4).status).toBe("warn");
    expect(checkFreeDisk("/x", () => 100).status).toBe("pass");
  });
  it("reaper emergency threshold", () => {
    expect(isDiskEmergency(2)).toBe(true);
    expect(isDiskEmergency(50)).toBe(false);
  });
});
