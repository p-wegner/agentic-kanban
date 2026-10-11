/** #1379: persisted `--profile-alias` entries live in the worker state file next to the pairings. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseProfileAliases, type ProfileAlias } from "../lib/local-profile-discovery.js";

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

/** Persist `given` when set, else read the saved list; parse it and log what is in force. */
export function resolveProfileAliases(stateFile: string, given: string[] | undefined, log: (m: string) => void): ProfileAlias[] {
  if (given) saveProfileAliases(stateFile, given);
  const aliases = parseProfileAliases(given ?? loadProfileAliases(stateFile));
  if (aliases.length > 0) log(`[worker] profile aliases: ${aliases.map((a) => `${a.source}=${a.name}`).join(", ")}`);
  return aliases;
}
