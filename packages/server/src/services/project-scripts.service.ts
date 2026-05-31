import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { projectScriptShortcuts, projects } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";

export class ProjectScriptsError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

type LastRunStatus = "running" | "success" | "failed" | "error";

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
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ?? null;
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
    const rows = await database
      .select()
      .from(projectScriptShortcuts)
      .where(eq(projectScriptShortcuts.projectId, projectId))
      .orderBy(projectScriptShortcuts.sortOrder, projectScriptShortcuts.createdAt);
    return rows.map(withLastRun);
  }

  async function create(projectId: string, body: Record<string, unknown>) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!name) throw new ProjectScriptsError("name is required", "BAD_REQUEST");
    if (!command) throw new ProjectScriptsError("command is required", "BAD_REQUEST");
    const workingDir = normalizeWorkingDir(body.workingDir);
    resolveWorkingDir(project.repoPath, workingDir);
    const existing = await database
      .select({ id: projectScriptShortcuts.id })
      .from(projectScriptShortcuts)
      .where(and(eq(projectScriptShortcuts.projectId, projectId), eq(projectScriptShortcuts.name, name)))
      .limit(1);
    if (existing[0]) throw new ProjectScriptsError(`Script shortcut "${name}" already exists`, "CONFLICT");
    const now = new Date().toISOString();
    const id = randomUUID();
    await database.insert(projectScriptShortcuts).values({
      id,
      projectId,
      name,
      command,
      workingDir,
      sortOrder: Number(body.sortOrder ?? 0),
      createdAt: now,
      updatedAt: now,
    });
    const rows = await database.select().from(projectScriptShortcuts).where(eq(projectScriptShortcuts.id, id)).limit(1);
    return withLastRun(rows[0]);
  }

  async function update(projectId: string, shortcutId: string, body: Record<string, unknown>) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await database
      .select()
      .from(projectScriptShortcuts)
      .where(and(eq(projectScriptShortcuts.id, shortcutId), eq(projectScriptShortcuts.projectId, projectId)))
      .limit(1);
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
    if (body.workingDir !== undefined) {
      const workingDir = normalizeWorkingDir(body.workingDir);
      resolveWorkingDir(project.repoPath, workingDir);
      updates.workingDir = workingDir;
    }
    if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder);
    await database.update(projectScriptShortcuts).set(updates).where(eq(projectScriptShortcuts.id, shortcutId));
    const updated = await database.select().from(projectScriptShortcuts).where(eq(projectScriptShortcuts.id, shortcutId)).limit(1);
    return withLastRun(updated[0]);
  }

  async function remove(projectId: string, shortcutId: string) {
    const rows = await database
      .select({ id: projectScriptShortcuts.id })
      .from(projectScriptShortcuts)
      .where(and(eq(projectScriptShortcuts.id, shortcutId), eq(projectScriptShortcuts.projectId, projectId)))
      .limit(1);
    if (!rows[0]) throw new ProjectScriptsError("Script shortcut not found", "NOT_FOUND");
    await database.delete(projectScriptShortcuts).where(eq(projectScriptShortcuts.id, shortcutId));
    lastRuns.delete(shortcutId);
  }

  async function run(projectId: string, shortcutId: string, onEvent: (event: ScriptRunEvent) => void) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await database
      .select()
      .from(projectScriptShortcuts)
      .where(and(eq(projectScriptShortcuts.id, shortcutId), eq(projectScriptShortcuts.projectId, projectId)))
      .limit(1);
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

    child.stdout?.on("data", (chunk) => onEvent({ type: "stdout", data: chunk.toString("utf8") }));
    child.stderr?.on("data", (chunk) => onEvent({ type: "stderr", data: chunk.toString("utf8") }));

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
