import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preferences, projects } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import {
  PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
  PROJECT_CONDUCTOR_STATE_RELATIVE_DIR,
  writeStrategyObjective,
} from "./strategy-objective.service.js";

export interface ProjectConductorConfig {
  enabled: boolean;
  agent: "claude" | "codex";
  cadenceSeconds: number;
}

const CONDUCTOR_KEY_RE = /^board_conductor_([0-9a-f-]+)$/;

export function parseProjectConductorConfig(raw: string | null | undefined): ProjectConductorConfig {
  if (!raw) return { enabled: false, agent: "codex", cadenceSeconds: 1800 };
  if (raw === "true") return { enabled: true, agent: "codex", cadenceSeconds: 1800 };
  if (raw === "false") return { enabled: false, agent: "codex", cadenceSeconds: 1800 };
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown; agent?: unknown; provider?: unknown; cadence?: unknown; cadenceSeconds?: unknown };
    const agent = parsed.agent === "claude" || parsed.provider === "claude" ? "claude" : "codex";
    const cadence = Number(parsed.cadenceSeconds ?? parsed.cadence);
    return {
      enabled: parsed.enabled === true,
      agent,
      cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? Math.round(cadence) : 1800,
    };
  } catch {
    return { enabled: false, agent: "codex", cadenceSeconds: 1800 };
  }
}

function projectIdFromConductorKey(key: string): string | null {
  return CONDUCTOR_KEY_RE.exec(key)?.[1] ?? null;
}

async function enabledProjectConductors(database: Database): Promise<Map<string, ProjectConductorConfig>> {
  const rows = await database.select().from(preferences);
  const enabled = new Map<string, ProjectConductorConfig>();
  for (const row of rows) {
    const projectId = projectIdFromConductorKey(row.key);
    if (!projectId) continue;
    const config = parseProjectConductorConfig(row.value);
    if (config.enabled) enabled.set(projectId, config);
  }
  return enabled;
}

async function ensureObjective(database: Database, project: typeof projects.$inferSelect): Promise<void> {
  const rows = await database.select().from(preferences);
  const strategyRaw = rows.find((row) => row.key === `board_strategy_${project.id}`)?.value ?? "{}";
  writeStrategyObjective(project.repoPath, strategyRaw, {
    objectiveRelativePath: PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH,
    createIfMissing: true,
    project,
  });
}

function requestStop(repoPath: string, options: { createStateDir?: boolean } = {}): void {
  const stateDir = join(repoPath, PROJECT_CONDUCTOR_STATE_RELATIVE_DIR);
  try {
    if (!options.createStateDir && !existsSync(stateDir)) return;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "STOP"), "", "utf8");
  } catch {
    /* best-effort graceful stop */
  }
}

export function startProjectConductorSupervisor(options: { database: Database; boardRepoRoot?: string; pollMs?: number }) {
  const database = options.database;
  const boardRepoRoot = options.boardRepoRoot ?? resolve(process.cwd());
  const loopScript = join(boardRepoRoot, "scripts", "board-monitor", "loop.sh");
  const pollMs = options.pollMs ?? 30_000;
  let stopped = false;
  let syncRunning = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const launched = new Map<string, string>();

  async function sync() {
    if (stopped || syncRunning) return;
    syncRunning = true;
    try {
      if (!existsSync(loopScript)) return;
      const configs = await enabledProjectConductors(database);
      const projectRows = await database.select().from(projects);
      const byId = new Map(projectRows.map((project) => [project.id, project]));

      for (const project of projectRows) {
        if (!configs.has(project.id)) requestStop(project.repoPath);
      }

      for (const [projectId, repoPath] of launched) {
        if (!configs.has(projectId)) {
          requestStop(repoPath, { createStateDir: true });
          launched.delete(projectId);
        }
      }

      for (const [projectId, config] of configs) {
        const project = byId.get(projectId);
        if (!project?.repoPath) continue;
        await ensureObjective(database, project);
        if (launched.has(projectId)) continue;
        const objectivePath = join(project.repoPath, PROJECT_CONDUCTOR_OBJECTIVE_RELATIVE_PATH);
        const stateDir = join(project.repoPath, PROJECT_CONDUCTOR_STATE_RELATIVE_DIR);
        mkdirSync(stateDir, { recursive: true });
        const child = spawn("bash", [
          loopScript,
          "--project", project.id,
          "--repo", project.repoPath,
          "--objective", objectivePath,
          "--state-dir", stateDir,
          "--agent", config.agent,
          "--sleep", String(config.cadenceSeconds),
        ], {
          cwd: boardRepoRoot,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.on("error", (err) => {
          launched.delete(projectId);
          console.warn(`[conductor] failed to launch project ${projectId}:`, err instanceof Error ? err.message : String(err));
        });
        child.unref();
        launched.set(projectId, project.repoPath);
        console.log(`[conductor] launched project ${projectId} (${project.name}) agent=${config.agent} cadence=${config.cadenceSeconds}s`);
      }
    } catch (err) {
      console.warn("[conductor] supervisor sync failed:", err instanceof Error ? err.message : String(err));
    } finally {
      syncRunning = false;
    }
  }

  timer = setInterval(() => void sync(), pollMs);
  timer.unref?.();
  void sync();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const repoPath of launched.values()) requestStop(repoPath, { createStateDir: true });
      launched.clear();
    },
    sync,
  };
}
