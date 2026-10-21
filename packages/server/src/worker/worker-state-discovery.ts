/**
 * #1661 — `doctor` without `--state-file` read the global default ("no pairing saved") while the
 * real daemon ran from `~/aks/state.json`, which looks like a broken pairing when it is not.
 * This picks the state file that actually holds a pairing: the explicit flag, else the default if
 * it has one, else the first well-known daemon location that does, else the default.
 *
 * Standalone-worker module: no db, no board services.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedStateFile {
  stateFile: string;
  /** Which rule chose it; printed so the operator knows what was read. */
  source: "flag" | "default" | "discovered" | "default-fallback";
}

/** Locations a hand-launched daemon is known to keep its pairing in (launcher `--state-file`). */
export function candidateStateFiles(home: string = homedir()): string[] {
  return [
    join(home, "aks", "state.json"),
    join(home, "aks", "worker-state.json"),
    join(home, ".aks", "state.json"),
  ];
}

export function stateFileHasPairing(file: string): boolean {
  try {
    if (!existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { boards?: Record<string, unknown>; urls?: Record<string, unknown> };
    return Object.keys(parsed.boards ?? {}).length > 0 || Object.keys(parsed.urls ?? {}).length > 0;
  } catch {
    return false;
  }
}

export function resolveDoctorStateFile(
  explicit: string | undefined,
  defaultFile: string,
  candidates: string[] = candidateStateFiles(),
  hasPairing: (file: string) => boolean = stateFileHasPairing,
): ResolvedStateFile {
  if (explicit) return { stateFile: explicit, source: "flag" };
  if (hasPairing(defaultFile)) return { stateFile: defaultFile, source: "default" };
  const found = candidates.find((c) => hasPairing(c));
  if (found) return { stateFile: found, source: "discovered" };
  return { stateFile: defaultFile, source: "default-fallback" };
}
