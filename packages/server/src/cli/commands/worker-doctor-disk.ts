// #1768 - the doctor's free-disk row. A worker whose disk is nearly full reports SQLITE_FULL as hundreds of
// red suites, and the board stops placing verify work on it; this row says so before that happens.
import { MIN_FREE_DISK_GB_VERIFY, workerBelowDiskFloor } from "@agentic-kanban/shared/lib/worker-settings";
import { freeDiskGb } from "../../worker/worker-resources.js";
import type { DoctorCheck } from "./worker-doctor.js";

export function checkFreeDisk(workRoot: string, read: (path: string) => number | undefined = freeDiskGb): DoctorCheck {
  const free = read(workRoot);
  if (free === undefined) return { name: "free disk", status: "skip", detail: `could not read free space under ${workRoot}` };
  const verdict = workerBelowDiskFloor(free);
  if (!verdict.below) return { name: "free disk", status: "pass", detail: `${free.toFixed(1)} GB free under ${workRoot} (verify floor ${MIN_FREE_DISK_GB_VERIFY} GB)` };
  return {
    name: "free disk",
    status: "warn",
    detail: `${verdict.reason}; the board will place no verify work here`,
    remedy: "Clear stale test fixture dirs in the temp directory (the test-reaper does an emergency sweep below the floor) and old worktrees under the work root.",
  };
}
