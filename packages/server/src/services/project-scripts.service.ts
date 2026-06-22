import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Database } from "../db/index.js";
import {
  getProjectForScripts,
  listProjectScriptShortcuts,
  findProjectScriptShortcutByName,
  insertProjectScriptShortcut,
  getProjectScriptShortcutById,
  getProjectScriptShortcutForProject,
  getProjectScriptShortcutIdForProject,
  updateProjectScriptShortcut,
  deleteProjectScriptShortcut,
} from "../repositories/project-scripts.repository.js";

export class ProjectScriptsError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

type LastRunStatus = "running" | "success" | "failed" | "error";
type CwdMode = "project" | "custom";

interface ScriptLastRun {
  status: LastRunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export type ScriptRunEvent =
  | { type: "start"; startedAt: string; cwd: string }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number | null; status: LastRunStatus; endedAt: string };

const lastRuns = new Map<string, ScriptLastRun>();

function normalizeWorkingDir(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new ProjectScriptsError("workingDir must be a string", "BAD_REQUEST");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) {
    throw new ProjectScriptsError("workingDir must be relative to the project root", "BAD_REQUEST");
  }
  return trimmed.replace(/\\/g, "/");
}

function normalizeNullableText(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new ProjectScriptsError(`${field} must be a string`, "BAD_REQUEST");
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCwdMode(value: unknown, workingDir: string | null): CwdMode {
  if (value == null) return workingDir ? "custom" : "project";
  if (value === "project" || value === "custom") return value;
  throw new ProjectScriptsError("cwdMode must be project or custom", "BAD_REQUEST");
}

function normalizeCwdInput(body: Record<string, unknown>) {
  const workingDir = normalizeWorkingDir(body.workingDir);
  const cwdMode = normalizeCwdMode(body.cwdMode, workingDir);
  if (cwdMode === "project") return { cwdMode, workingDir: null };
  if (!workingDir) {
    throw new ProjectScriptsError("workingDir is required when cwdMode is custom", "BAD_REQUEST");
  }
  return { cwdMode, workingDir };
}

function resolveWorkingDir(repoPath: string, workingDir: string | null): string {
  const root = resolve(repoPath);
  const cwd = workingDir ? resolve(root, workingDir) : root;
  if (cwd !== root && !cwd.startsWith(root + sep)) {
    throw new ProjectScriptsError("workingDir must stay inside the project root", "BAD_REQUEST");
  }
  if (!existsSync(cwd)) {
    throw new ProjectScriptsError(`Working directory does not exist: ${workingDir ?? "."}`, "BAD_REQUEST");
  }
  return cwd;
}

async function getProject(projectId: string, database: Database) {
  return getProjectForScripts(projectId, database);
}

function withLastRun<T extends { id: string }>(row: T) {
  return {
    ...row,
    lastRun: lastRuns.get(row.id) ?? null,
  };
}

export function createProjectScriptsService(deps: { database: Database }) {
  const { database } = deps;

  async function list(projectId: string) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await listProjectScriptShortcuts(projectId, database);
    return rows.map(withLastRun);
  }

  async function create(projectId: string, body: Record<string, unknown>) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!name) throw new ProjectScriptsError("name is required", "BAD_REQUEST");
    if (!command) throw new ProjectScriptsError("command is required", "BAD_REQUEST");
    const description = normalizeNullableText(body.description, "description");
    const { cwdMode, workingDir } = normalizeCwdInput(body);
    resolveWorkingDir(project.repoPath, workingDir);
    const existing = await findProjectScriptShortcutByName(projectId, name, database);
    if (existing[0]) throw new ProjectScriptsError(`Script shortcut "${name}" already exists`, "CONFLICT");
    const now = new Date().toISOString();
    const id = randomUUID();
    await insertProjectScriptShortcut({
      id,
      projectId,
      name,
      description,
      command,
      cwdMode,
      workingDir,
      sortOrder: Number(body.sortOrder ?? 0),
      createdAt: now,
      updatedAt: now,
    }, database);
    const rows = await getProjectScriptShortcutById(id, database);
    return withLastRun(rows[0]);
  }

  async function update(projectId: string, shortcutId: string, body: Record<string, unknown>) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await getProjectScriptShortcutForProject(shortcutId, projectId, database);
    if (!rows[0]) throw new ProjectScriptsError("Script shortcut not found", "NOT_FOUND");
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) throw new ProjectScriptsError("name is required", "BAD_REQUEST");
      updates.name = name;
    }
    if (body.command !== undefined) {
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command) throw new ProjectScriptsError("command is required", "BAD_REQUEST");
      updates.command = command;
    }
    if (body.description !== undefined) {
      updates.description = normalizeNullableText(body.description, "description");
    }
    if (body.cwdMode !== undefined || body.workingDir !== undefined) {
      const nextBody = {
        cwdMode: body.cwdMode ?? rows[0].cwdMode,
        workingDir: body.workingDir !== undefined ? body.workingDir : rows[0].workingDir,
      };
      const { cwdMode, workingDir } = normalizeCwdInput(nextBody);
      resolveWorkingDir(project.repoPath, workingDir);
      updates.cwdMode = cwdMode;
      updates.workingDir = workingDir;
    }
    if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder);
    await updateProjectScriptShortcut(shortcutId, updates, database);
    const updated = await getProjectScriptShortcutById(shortcutId, database);
    return withLastRun(updated[0]);
  }

  async function remove(projectId: string, shortcutId: string) {
    const rows = await getProjectScriptShortcutIdForProject(shortcutId, projectId, database);
    if (!rows[0]) throw new ProjectScriptsError("Script shortcut not found", "NOT_FOUND");
    await deleteProjectScriptShortcut(shortcutId, database);
    lastRuns.delete(shortcutId);
  }

  async function run(projectId: string, shortcutId: string, onEvent: (event: ScriptRunEvent) => void) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await getProjectScriptShortcutForProject(shortcutId, projectId, database);
    const shortcut = rows[0];
    if (!shortcut) throw new ProjectScriptsError("Script shortcut not found", "NOT_FOUND");
    const cwd = resolveWorkingDir(project.repoPath, shortcut.workingDir);
    const startedAt = new Date().toISOString();
    lastRuns.set(shortcutId, { status: "running", startedAt, endedAt: null, exitCode: null });
    onEvent({ type: "start", startedAt, cwd });

    const isWindows = process.platform === "win32";
    const child: ChildProcess = spawn(
      isWindows ? "cmd.exe" : "/bin/sh",
      isWindows ? ["/d", "/s", "/c", shortcut.command] : ["-c", shortcut.command],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout?.on("data", (chunk: Buffer) => onEvent({ type: "stdout", data: chunk.toString("utf8") }));
    child.stderr?.on("data", (chunk: Buffer) => onEvent({ type: "stderr", data: chunk.toString("utf8") }));

    return new Promise<void>((resolvePromise) => {
      let finished = false;
      function finish(status: LastRunStatus, exitCode: number | null, extraStderr?: string) {
        if (finished) return;
        finished = true;
        const endedAt = new Date().toISOString();
        lastRuns.set(shortcutId, { status, startedAt, endedAt, exitCode });
        if (extraStderr) onEvent({ type: "stderr", data: extraStderr });
        onEvent({ type: "exit", exitCode, status, endedAt });
        resolvePromise();
      }

      child.on("error", (err) => {
        finish("error", null, `${err instanceof Error ? err.message : String(err)}\n`);
      });
      child.on("close", (code) => {
        const status: LastRunStatus = code === 0 ? "success" : "failed";
        finish(status, code);
      });
    });
  }

  return { list, create, update, remove, run };
}
