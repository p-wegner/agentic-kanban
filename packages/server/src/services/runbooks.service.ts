/**
 * Runbook discovery + reading (#606).
 *
 * This lived inline in `routes/runbooks.ts`, which made that route a 150-line aggregator
 * doing its own `fs` walking — one of the five routes that bypass the service layer while
 * `packages/server/CLAUDE.md` says the adapter stays thin.
 *
 * The path-traversal guard moved WITH the read, deliberately. It used to sit in the route
 * body, so it protected exactly one caller: anything else that later wanted a runbook's
 * content would have had to remember to re-implement it. Now it is impossible to read a
 * runbook without it.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

export interface RunbookEntry {
  path: string;
  title: string;
  lastModified: string;
}

/** Well-known files with hand-crafted titles. Paths use forward slashes. */
const STATIC_RUNBOOKS: Array<{ rel: string; title: string }> = [
  { rel: "CLAUDE.md", title: "CLAUDE.md — Project Setup & Guidelines" },
  { rel: "CLAUDE.local.md", title: "CLAUDE.local.md — Local Overrides" },
  { rel: "scripts/board-monitor/README.md", title: "Board Monitor — Runbook" },
];

/** Directories to scan for additional *.md files. Paths use forward slashes. */
const SCAN_DIRS = ["docs/learnings", "docs/decisions"];

/**
 * Derive a human-readable title from a filename (without extension).
 * Replaces hyphens and underscores with spaces; keeps dates as-is.
 */
function titleFromFilename(filename: string): string {
  const name = basename(filename, extname(filename));
  return name.replace(/[-_]+/g, " ");
}

/** Return stat or null without throwing. */
async function statSafe(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** Return readdir result or empty array without throwing. */
async function readdirSafe(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

/** Resolve a relative path string to use forward slashes (cross-platform). */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

async function collectRunbooks(repoPath: string): Promise<RunbookEntry[]> {
  const entries: RunbookEntry[] = [];

  // Static entries with well-known titles
  for (const { rel, title } of STATIC_RUNBOOKS) {
    const abs = join(repoPath, rel);
    const s = await statSafe(abs);
    if (s && s.isFile()) {
      entries.push({ path: rel, title, lastModified: s.mtime.toISOString() });
    }
  }

  // Scanned directories
  for (const relDir of SCAN_DIRS) {
    const absDir = join(repoPath, relDir);
    const files = await readdirSafe(absDir);
    for (const file of files.filter((f) => f.toLowerCase().endsWith(".md")).sort()) {
      const abs = join(absDir, file);
      const s = await statSafe(abs);
      if (s && s.isFile()) {
        const relPath = toForwardSlashes(relative(repoPath, abs));
        entries.push({
          path: relPath,
          title: titleFromFilename(file),
          lastModified: s.mtime.toISOString(),
        });
      }
    }
  }

  return entries;
}


export interface RunbookContent extends RunbookEntry {
  content: string;
}

/** List a project's runbooks: the well-known files plus every .md under the scan dirs. */
export async function listRunbooks(repoPath: string): Promise<RunbookEntry[]> {
  return collectRunbooks(repoPath);
}

/** Why a runbook could not be returned — the route maps these to distinct status codes. */
export type RunbookReadFailure = "invalid-path" | "not-found";

export type RunbookReadResult =
  | { ok: true; runbook: RunbookContent }
  | { ok: false; reason: RunbookReadFailure };

/**
 * Read one runbook by repo-relative path.
 *
 * Returns a DISCRIMINATED failure rather than null: the route answers 400 for a traversal
 * attempt and 404 for a missing file, and collapsing both to null silently turned the
 * former into a 404 (caught by runbooks.test.ts). Hiding existence from the client would
 * be a defensible API choice, but it is an API choice — not something a layering refactor
 * gets to make on the way past.
 */
export async function readRunbook(repoPath: string, relPath: string): Promise<RunbookReadResult> {
  if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) {
    return { ok: false, reason: "invalid-path" };
  }
  const absPath = resolve(join(repoPath, relPath));
  // Re-check after resolution: covers anything the string test misses.
  const rel = relative(repoPath, absPath);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    return { ok: false, reason: "invalid-path" };
  }
  try {
    const [content, s] = await Promise.all([readFile(absPath, "utf-8"), stat(absPath)]);
    const staticEntry = STATIC_RUNBOOKS.find((r) => r.rel === relPath);
    return {
      ok: true,
      runbook: {
        path: relPath,
        title: staticEntry ? staticEntry.title : titleFromFilename(basename(relPath)),
        lastModified: s.mtime.toISOString(),
        content,
      },
    };
  } catch {
    return { ok: false, reason: "not-found" };
  }
}
