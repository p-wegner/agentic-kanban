import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Database } from "../db/index.js";
import { spawnShellCommand } from "./process-exec.js";
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
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveProjectId } from "../repositories/workspace.repository.js";
import { resolveRemotePlacement } from "./workspace-remote-placement.js";

export class ProjectScriptsError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
  ) {
    super(message);
  }
}

/** A shortcut that has not finished in this long on a worker is abandoned (the board is not streaming it). */
const SCRIPT_TIMEOUT_MS = 30 * 60_000;

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

  /**
   * Run a shortcut. With `workspaceId` whose builder is placed on a fleet worker (#1447), it runs
   * THERE, in the worker's checkout of the workspace branch — the host worktree has no installed
   * dependencies. Output arrives when the run ends rather than streaming. Host-placed: as always.
   */
  async function run(projectId: string, shortcutId: string, onEvent: (event: ScriptRunEvent) => void, opts: { workspaceId?: string } = {}) {
    const project = await getProject(projectId, database);
    if (!project) throw new ProjectScriptsError("Project not found", "NOT_FOUND");
    const rows = await getProjectScriptShortcutForProject(shortcutId, projectId, database);
    const shortcut = rows[0];
    if (!shortcut) throw new ProjectScriptsError("Script shortcut not found", "NOT_FOUND");
    const cwd = resolveWorkingDir(project.repoPath, shortcut.workingDir);
    const placement = await placeOnWorker(projectId, opts.workspaceId);
    const startedAt = new Date().toISOString();
    lastRuns.set(shortcutId, { status: "running", startedAt, endedAt: null, exitCode: null });
    if (placement) {
      onEvent({ type: "start", startedAt, cwd: `worker ${placement.workerId}:${shortcut.workingDir ?? "."}` });
      const res = await placement.client.exec({
        workerId: placement.workerId, sessionId: placement.sessionId, workspaceId: opts.workspaceId!, label: `script:${shortcutId}`,
        command: shortcut.command, cwdRel: shortcut.workingDir ?? "", timeoutMs: SCRIPT_TIMEOUT_MS,
      });
      if (res.stdout) onEvent({ type: "stdout", data: res.stdout });
      if (res.stderr) onEvent({ type: "stderr", data: res.stderr });
      if (!res.ok && res.error) onEvent({ type: "stderr", data: `${res.error}
` });
      const endedAt = new Date().toISOString();
      const status: LastRunStatus = res.ok ? "success" : res.code == null ? "error" : "failed";
      lastRuns.set(shortcutId, { status, startedAt, endedAt, exitCode: res.code ?? null });
      onEvent({ type: "exit", exitCode: res.code ?? null, status, endedAt });
      return;
    }
    onEvent({ type: "start", startedAt, cwd });

    const child: ChildProcess = spawnShellCommand(shortcut.command, { cwd, stdio: ["ignore", "pipe", "pipe"] });

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
        finish("error", null, `${errorMessage(err)}\n`);
      });
      child.on("close", (code) => {
        const status: LastRunStatus = code === 0 ? "success" : "failed";
        finish(status, code);
      });
    });
  }

  /** The worker holding `workspaceId`'s session, when the workspace belongs to this project and is worker-placed. */
  async function placeOnWorker(projectId: string, workspaceId: string | undefined) {
    if (!workspaceId) return null;
    if ((await resolveProjectId(workspaceId, database)) !== projectId) {
      throw new ProjectScriptsError("Workspace does not belong to this project", "BAD_REQUEST");
    }
    return resolveRemotePlacement(workspaceId, database);
  }

  return { list, create, update, remove, run };
}
