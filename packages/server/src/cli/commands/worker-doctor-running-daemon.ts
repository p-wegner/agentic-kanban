// #1453: doctor's "running daemon" check. The other checks open a FRESH connection of their own, so
// doctor could pass while the daemon that actually serves the board held no socket or attested nothing.
// This asks the running daemon (its loopback control endpoint) who it is and what it advertises.
// Db-free: ships in the standalone worker binary.
import { fetchWorkerStatus } from "../../worker/worker-control.js";
import type { DoctorCheck } from "./worker-doctor.js";

const NAME = "running daemon";

function list(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join(",") : null;
}

/** Pure part: turn the daemon's `/status` body (or its absence) into a check. */
export function describeRunningDaemon(status: (Record<string, unknown> & { pid?: number }) | null, controlFileExists: boolean): DoctorCheck {
  if (!status) {
    return controlFileExists
      ? { name: NAME, status: "warn", detail: "a control file exists but the daemon did not answer on it (stale file or a dead daemon)", remedy: "Start it: agentic-kanban-worker start --board <url> --auto-update" }
      : { name: NAME, status: "warn", detail: "no worker daemon is running for this state file, so the board cannot hand this machine any work", remedy: "Start it: agentic-kanban-worker start --board <url> --auto-update (or the scheduled task from the runbook)" };
  }
  const parts: string[] = [`pid ${status.pid ?? "?"}`];
  for (const key of ["name", "workerName"]) if (typeof status[key] === "string") { parts.push(`name ${status[key]}`); break; }
  const labels = list(status.labels);
  if (labels) parts.push(`labels ${labels}`);
  const providers = list(status.providers);
  if (providers) parts.push(`providers ${providers}`);
  const profiles = list(status.profiles) ?? list(status.attestedProfiles);
  parts.push(`attested profiles ${profiles ?? "none reported"}`);
  if (typeof status.workerVersion === "string") parts.push(`build ${status.workerVersion}`);
  if (status.draining === true) parts.push("DRAINING");
  const detail = `${parts.join("; ")}. The board's view (WebSocket held, eligibility): agentic-kanban worker doctor-board, on the board machine.`;
  if (status.draining === true) return { name: NAME, status: "warn", detail, remedy: "A draining daemon takes no new work: restart it (agentic-kanban-worker restart)." };
  return { name: NAME, status: "pass", detail };
}

/** #1558: the profiles the RUNNING daemon attests (null when it reports none), for the attested-profiles check. */
export function daemonAttestedProfiles(status: Record<string, unknown> | null): string | null {
  return status ? (list(status.profiles) ?? list(status.attestedProfiles)) : null;
}

/** The check plus the raw status, so a caller can reuse what the daemon said without a second request. */
export async function checkRunningDaemonWithStatus(
  stateFile: string,
  controlFileExists: boolean,
  fetchImpl?: typeof fetch,
): Promise<{ check: DoctorCheck; status: Record<string, unknown> | null }> {
  const status = await fetchWorkerStatus(stateFile, fetchImpl);
  return { check: describeRunningDaemon(status, controlFileExists), status };
}

export async function checkRunningDaemon(stateFile: string, controlFileExists: boolean, fetchImpl?: typeof fetch): Promise<DoctorCheck> {
  return (await checkRunningDaemonWithStatus(stateFile, controlFileExists, fetchImpl)).check;
}
