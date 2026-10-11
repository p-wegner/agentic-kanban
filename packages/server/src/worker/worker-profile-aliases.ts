/** #1379: persisted `--profile-alias` entries live in the worker state file next to the pairings. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function readState(stateFile: string): { profileAliases?: unknown; [k: string]: unknown } {
  try {
    return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  } catch {
    return {};
  }
}

/** The persisted entries (`<source>=<name>`), empty when none were ever set. */
export function loadProfileAliases(stateFile: string): string[] {
  const raw = readState(stateFile).profileAliases;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Persist the list; an empty list clears it. Paired identities are left untouched. */
export function saveProfileAliases(stateFile: string, aliases: string[]): void {
  const state = readState(stateFile);
  if (aliases.length > 0) state.profileAliases = aliases;
  else delete state.profileAliases;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
