import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";

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

/**
 * Runbooks route — surfaces project operational docs without leaving the app.
 * Mounted under /projects.
 *
 * GET /api/projects/:id/runbooks          — list available runbook/doc files
 * GET /api/projects/:id/runbooks/content  — serve file content by ?path= query param
 */
export function createRunbooksRoute(database: Database) {
  const router = createRouter();

  // GET /api/projects/:id/runbooks — list available docs
  router.get("/:id/runbooks", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    const entries = await collectRunbooks(project.repoPath);
    return c.json(entries);
  });

  // GET /api/projects/:id/runbooks/content?path=<relative-path> — read file content
  router.get("/:id/runbooks/content", async (c) => {
    const projectId = c.req.param("id");
    const relPath = c.req.query("path");
    if (!relPath) {
      return c.json({ error: "path query param is required" }, 400);
    }
    // Security: reject traversal attempts and absolute paths
    if (relPath.includes("..") || relPath.startsWith("/") || relPath.startsWith("\\")) {
      return c.json({ error: "invalid path" }, 400);
    }
    const project = await getProjectById(projectId, database);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    const absPath = resolve(join(project.repoPath, relPath));
    // Ensure resolved path stays within repoPath (covers any remaining edge cases)
    const rel = relative(project.repoPath, absPath);
    if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
      return c.json({ error: "invalid path" }, 400);
    }
    try {
      const [content, s] = await Promise.all([
        readFile(absPath, "utf-8"),
        stat(absPath),
      ]);
      // Use hand-crafted title for well-known files, fall back to filename
      const staticEntry = STATIC_RUNBOOKS.find((r) => r.rel === relPath);
      const title = staticEntry ? staticEntry.title : titleFromFilename(basename(relPath));
      return c.json({
        path: relPath,
        title,
        lastModified: s.mtime.toISOString(),
        content,
      });
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  return router;
}
