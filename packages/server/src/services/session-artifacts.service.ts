import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute } from "node:path";
import type { Database } from "../db/index.js";
import { workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

export interface ArtifactEntry {
  /** Relative path from the workspace workingDir */
  path: string;
  /** Artifact category */
  type: "image" | "text" | "trace" | "other";
  /** File size in bytes */
  size: number;
  /** ISO timestamp of last modification */
  modified: string;
  /** Human-readable file extension (e.g. ".png") */
  ext: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".md", ".json", ".xml", ".yaml", ".yml",
  ".csv", ".tsv", ".html", ".css", ".js", ".ts", ".tsx", ".jsx",
  ".sh", ".bat", ".ps1", ".py", ".toml", ".ini", ".cfg", ".env",
]);
const TRACE_EXTENSIONS = new Set([".zip", ".trace", ".trace.gz", ".jsonl"]);

const MAX_RECURSE_DEPTH = 4;

/**
 * Resolve and validate that a target path is within the workspace workingDir.
 * Returns the resolved absolute path or throws.
 */
export function resolveSafePath(workingDir: string, requestedPath: string): string {
  const base = resolve(workingDir);
  const target = resolve(base, requestedPath);

  // Must be inside workingDir (prevent traversal with .. or absolute paths)
  if (!isPathInside(base, target)) {
    throw new Error("Path is outside the workspace directory");
  }
  return target;
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  const rel = relative(baseDir, targetPath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveSafeExistingPath(workingDir: string, requestedPath: string): Promise<string> {
  const lexicalTarget = resolveSafePath(workingDir, requestedPath);
  const [realBase, realTarget] = await Promise.all([
    realpath(workingDir),
    realpath(lexicalTarget),
  ]);
  if (!isPathInside(realBase, realTarget)) {
    throw new Error("Path is outside the workspace directory");
  }
  return realTarget;
}

/**
 * Classify a file extension into an artifact category.
 */
export function classifyArtifact(ext: string): ArtifactEntry["type"] {
  const lower = ext.toLowerCase();
  if (IMAGE_EXTENSIONS.has(lower)) return "image";
  if (TEXT_EXTENSIONS.has(lower)) return "text";
  if (TRACE_EXTENSIONS.has(lower)) return "trace";
  return "other";
}

/**
 * Recursively scan a directory for recognized artifacts.
 */
async function scanDir(
  dir: string,
  baseDir: string,
  depth: number,
  results: ArtifactEntry[],
): Promise<void> {
  if (depth > MAX_RECURSE_DEPTH) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist or is unreadable — return empty
    return;
  }

  for (const entry of entries) {
    // Skip hidden directories and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await scanDir(fullPath, baseDir, depth + 1, results);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      const type = classifyArtifact(ext);
      // Skip "other" types — only list recognized artifacts
      if (type === "other") continue;

      try {
        const fileStat = await stat(fullPath);
        results.push({
          path: relative(baseDir, fullPath).split("\\").join("/"),
          type,
          size: fileStat.size,
          modified: fileStat.mtime.toISOString(),
          ext,
        });
      } catch {
        // File vanished or unreadable — skip
      }
    }
  }
}

/**
 * Create the session artifacts service.
 */
export function createSessionArtifactsService(deps: { database: Database }) {
  const { database } = deps;

  async function getWorkspaceDir(workspaceId: string): Promise<string> {
    const rows = await database
      .select({ workingDir: workspaces.workingDir })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (rows.length === 0) {
      throw new Error("Workspace not found");
    }
    const workingDir = rows[0].workingDir;
    if (!workingDir) {
      throw new Error("Workspace has no working directory");
    }
    return workingDir;
  }

  /**
   * List all recognized artifacts in the workspace directory.
   */
  async function listArtifacts(workspaceId: string): Promise<ArtifactEntry[]> {
    const workingDir = await getWorkspaceDir(workspaceId);
    const results: ArtifactEntry[] = [];
    await scanDir(workingDir, workingDir, 0, results);

    // Sort: images first, then text, then traces; within each group by path
    const typeOrder: Record<string, number> = { image: 0, text: 1, trace: 2 };
    results.sort((a, b) => {
      const typeDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
      if (typeDiff !== 0) return typeDiff;
      return a.path.localeCompare(b.path);
    });

    return results;
  }

  /**
   * Read a text artifact from the workspace.
   * Enforces path safety.
   */
  async function readTextArtifact(workspaceId: string, artifactPath: string): Promise<{ content: string; path: string }> {
    const workingDir = await getWorkspaceDir(workspaceId);
    const fullPath = await resolveSafeExistingPath(workingDir, artifactPath);

    const ext = extname(fullPath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read ${ext || "extensionless"} file as text`);
    }

    const content = await readFile(fullPath, "utf-8");
    return {
      content,
      path: artifactPath,
    };
  }

  /**
   * Read an image artifact as a Buffer with its mime type.
   * Enforces path safety.
   */
  async function readImageArtifact(workspaceId: string, artifactPath: string): Promise<{ buffer: Buffer; mimeType: string; path: string }> {
    const workingDir = await getWorkspaceDir(workspaceId);
    const fullPath = await resolveSafeExistingPath(workingDir, artifactPath);

    const ext = extname(fullPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`Cannot read ${ext || "extensionless"} file as image`);
    }

    const MIME_MAP: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
    };

    const buffer = await readFile(fullPath);
    return {
      buffer,
      mimeType: MIME_MAP[ext] ?? "application/octet-stream",
      path: artifactPath,
    };
  }

  return {
    listArtifacts,
    readTextArtifact,
    readImageArtifact,
    getWorkspaceDir,
  };
}
