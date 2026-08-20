import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * #165: the resolver-level fix (db-path.ts rule 3) stops a stub file from being
 * silently adopted, but it is a heuristic (a size floor), not a proof. This is the
 * backstop: persist which DB the CLI resolved to on THIS invocation, so the NEXT
 * invocation can compare and warn loudly if resolution changed underneath the
 * user — the exact symptom that let the #165 split-brain go unnoticed across
 * several CLI calls in one session. Kept in the home dir (not the resolved DB's
 * own directory) so the marker survives even when resolution itself is what
 * flipped between the two invocations being compared.
 */
const MARKER_DIR = join(homedir(), ".agentic-kanban");
const MARKER_FILE = join(MARKER_DIR, ".last-cli-db-path");

/** Pure — exposed separately so the warning text is unit-testable without touching disk. */
export function dbResolutionFlipWarning(
  current: { source: string; path: string | null; url: string },
  lastResolvedPath: string | null,
): string | null {
  if (lastResolvedPath === null) return null;
  const currentPath = current.path ?? current.url;
  if (currentPath === lastResolvedPath) return null;
  return (
    `⚠ agentic-kanban CLI resolved a DIFFERENT database than the last invocation:\n` +
    `    previous: ${lastResolvedPath}\n` +
    `    now:      ${currentPath}  (source: ${current.source})\n` +
    `  A database file likely appeared or disappeared on disk between runs. If this is\n` +
    `  unexpected, stop and check AGENTIC_KANBAN_DIR / DB_URL before reading or writing —\n` +
    `  one of these two locations may hold stale or empty data.`
  );
}

function readLastResolvedPath(): string | null {
  try {
    const raw = readFileSync(MARKER_FILE, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeLastResolvedPath(path: string): void {
  try {
    if (!existsSync(MARKER_DIR)) mkdirSync(MARKER_DIR, { recursive: true });
    writeFileSync(MARKER_FILE, path, "utf8");
  } catch {
    // Best-effort: never let the marker write block a CLI command.
  }
}

/**
 * Compare the current resolution against the persisted last one, then record the
 * current one for next time. Returns the warning text (or null) — never throws.
 */
export function checkAndRecordDbResolution(loc: {
  source: string;
  path: string | null;
  url: string;
}): string | null {
  const currentPath = loc.path ?? loc.url;
  let warning: string | null = null;
  try {
    warning = dbResolutionFlipWarning(loc, readLastResolvedPath());
  } catch {
    warning = null;
  }
  writeLastResolvedPath(currentPath);
  return warning;
}
