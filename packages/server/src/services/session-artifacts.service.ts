import { readdir, stat, readFile, realpath } from "node:fs/promises";
import { join, resolve, extname, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Database } from "../db/index.js";
import { issueArtifacts } from "@agentic-kanban/shared/schema";
import {
  getWorkspaceWorkingDirAndBase,
  workspaceExists,
  getWorkspaceArtifacts,
} from "../repositories/session-artifacts.repository.js";

const execFileAsync = promisify(execFile);

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

  interface WorkspaceInfo {
    workingDir: string;
    baseBranch: string | null;
  }

  async function getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const row = await getWorkspaceWorkingDirAndBase(workspaceId, database);

    if (!row) {
      throw new Error("Workspace not found");
    }
    const { workingDir, baseBranch } = row;
    if (!workingDir) {
      throw new Error("Workspace has no working directory");
    }
    return { workingDir, baseBranch };
  }

  async function getWorkspaceDir(workspaceId: string): Promise<string> {
    return (await getWorkspaceInfo(workspaceId)).workingDir;
  }

  /**
   * List the persisted visual-proof artifacts (issue_artifacts rows) for a workspace,
   * newest-relevant order. Returns null when the workspace does not exist so the caller
   * can respond 404 without the transport layer touching the database.
   */
  async function listVisualProof(
    workspaceId: string,
  ): Promise<(typeof issueArtifacts.$inferSelect)[] | null> {
    const exists = await workspaceExists(workspaceId, database);
    if (!exists) return null;
    return getWorkspaceArtifacts(workspaceId, database);
  }

  /** Get paths of files changed or added relative to baseBranch (git diff + untracked). */
  async function getChangedPaths(workingDir: string, baseBranch: string | null): Promise<Set<string> | null> {
    if (!baseBranch) return null;
    try {
      const [diffOut, untrackedOut] = await Promise.all([
        execFileAsync("git", ["diff", "--name-only", `${baseBranch}...HEAD`], { cwd: workingDir })
          .then((r) => r.stdout)
          .catch(() => ""),
        execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: workingDir })
          .then((r) => r.stdout)
          .catch(() => ""),
      ]);
      const paths = new Set<string>();
      for (const line of (diffOut + "\n" + untrackedOut).split("\n")) {
        const p = line.trim();
        if (p) paths.add(p.split("\\").join("/"));
      }
      return paths;
    } catch {
      return null;
    }
  }

  /**
   * List recognized artifacts in the workspace directory.
   * When a baseBranch is available, only files changed or new relative to that branch are shown.
   */
  async function listArtifacts(workspaceId: string): Promise<ArtifactEntry[]> {
    const { workingDir, baseBranch } = await getWorkspaceInfo(workspaceId);
    const changedPaths = await getChangedPaths(workingDir, baseBranch);
    const results: ArtifactEntry[] = [];
    await scanDir(workingDir, workingDir, 0, results);

    const filtered = changedPaths ? results.filter((a) => changedPaths.has(a.path)) : results;

    // Sort: images first, then text, then traces; within each group by path
    const typeOrder: Record<string, number> = { image: 0, text: 1, trace: 2 };
    filtered.sort((a, b) => {
      const typeDiff = (typeOrder[a.type] ?? 3) - (typeOrder[b.type] ?? 3);
      if (typeDiff !== 0) return typeDiff;
      return a.path.localeCompare(b.path);
    });

    return filtered;
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
    listVisualProof,
  };
}
