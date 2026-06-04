import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createPreferenceService } from "../services/preference.service.js";
import { createProjectService } from "../services/project.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { isBoardStrategyKey } from "../services/strategy-objective.service.js";

export const CONFIG_EXPORT_VERSION = 1;

/** Workflow preferences safe to export — no secrets, no profiles, no per-ID session data. */
export const WORKFLOW_PREF_KEYS = ["auto_merge", "auto_review", "dynamic_column_scaling"] as const;

export interface BoardConfigExport {
  version: number;
  exportedAt: string;
  projectId: string;
  statuses: Array<{ name: string; sortOrder: number; isDefault?: boolean | null }>;
  boardStrategy: unknown | null;
  workflowPreferences: Record<string, string>;
}

function parseBoardStrategy(raw: string | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function validateBoardConfigShape(body: unknown): { config: BoardConfigExport; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    errors.push("Body must be a JSON object");
    return { config: null as unknown as BoardConfigExport, errors };
  }
  const obj = body as Record<string, unknown>;

  if (obj.version !== 1) {
    errors.push(`Unsupported config version: ${obj.version}`);
  }

  if (!Array.isArray(obj.statuses)) {
    errors.push("statuses must be an array");
  } else {
    for (let i = 0; i < obj.statuses.length; i++) {
      const s = obj.statuses[i];
      if (typeof s !== "object" || s === null) {
        errors.push(`statuses[${i}] must be an object`);
        continue;
      }
      const so = s as Record<string, unknown>;
      if (typeof so.name !== "string" || !so.name.trim()) {
        errors.push(`statuses[${i}].name is required`);
      }
      if (typeof so.sortOrder !== "number") {
        errors.push(`statuses[${i}].sortOrder must be a number`);
      }
    }
  }

  if (
    obj.workflowPreferences !== undefined &&
    (typeof obj.workflowPreferences !== "object" ||
      obj.workflowPreferences === null ||
      Array.isArray(obj.workflowPreferences))
  ) {
    errors.push("workflowPreferences must be an object");
  }

  if (errors.length > 0) return { config: null as unknown as BoardConfigExport, errors };

  const workflowPreferences: Record<string, string> = {};
  if (obj.workflowPreferences && typeof obj.workflowPreferences === "object") {
    const allowed = new Set<string>(WORKFLOW_PREF_KEYS);
    for (const [k, v] of Object.entries(obj.workflowPreferences as Record<string, unknown>)) {
      if (allowed.has(k) && typeof v === "string") {
        workflowPreferences[k] = v;
      }
    }
  }

  return {
    config: {
      version: 1,
      exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
      projectId: typeof obj.projectId === "string" ? obj.projectId : "",
      statuses: (obj.statuses as Array<Record<string, unknown>>).map((s) => ({
        name: String(s.name).trim(),
        sortOrder: Number(s.sortOrder),
        isDefault: typeof s.isDefault === "boolean" ? s.isDefault : null,
      })),
      boardStrategy: obj.boardStrategy !== undefined ? obj.boardStrategy : null,
      workflowPreferences,
    },
    errors: [],
  };
}

export function createConfigExportImportRoute(database: Database = db) {
  const router = createRouter();
  const preferenceService = createPreferenceService({ database });
  const projectService = createProjectService({ database });

  // GET /api/projects/:projectId/config/export
  router.get("/:projectId/config/export", async (c) => {
    const projectId = c.req.param("projectId");

    const [statuses, settings] = await Promise.all([
      projectService.listStatuses(projectId),
      preferenceService.getSettings(),
    ]);

    const boardStrategyKey = `board_strategy_${projectId}`;
    const boardStrategy = parseBoardStrategy(settings[boardStrategyKey]);

    const workflowPreferences: Record<string, string> = {};
    for (const key of WORKFLOW_PREF_KEYS) {
      if (settings[key] !== undefined) {
        workflowPreferences[key] = settings[key];
      }
    }

    const exportData: BoardConfigExport = {
      version: CONFIG_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      projectId,
      statuses: statuses.map((s) => ({
        name: s.name,
        sortOrder: s.sortOrder,
        isDefault: s.isDefault,
      })),
      boardStrategy,
      workflowPreferences,
    };

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="board-config-${projectId}.json"`,
      },
    });
  });

  // POST /api/projects/:projectId/config/import
  router.post("/:projectId/config/import", async (c) => {
    const projectId = c.req.param("projectId");
    const contentType = c.req.header("content-type") ?? "";

    let rawBody: unknown;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return c.json({ error: "multipart upload must include a 'file' field" }, 400);
      }
      const text = await (file as File).text();
      try {
        rawBody = JSON.parse(text);
      } catch {
        return c.json({ error: "Could not parse file as JSON" }, 400);
      }
    } else if (contentType.includes("application/json")) {
      rawBody = await c.req.json();
    } else {
      return c.json({ error: "Content-Type must be application/json or multipart/form-data" }, 400);
    }

    const { config, errors } = validateBoardConfigShape(rawBody);
    if (errors.length > 0) {
      return c.json({ error: "Invalid config shape", details: errors }, 400);
    }

    // Fetch current state so the caller can review changes
    const [currentStatuses, currentSettings] = await Promise.all([
      projectService.listStatuses(projectId),
      preferenceService.getSettings(),
    ]);

    const boardStrategyKey = `board_strategy_${projectId}`;
    const statusChanges = {
      toAdd: config.statuses.filter(
        (s) => !currentStatuses.some((cs) => cs.name.toLowerCase() === s.name.toLowerCase()),
      ),
      toUpdate: config.statuses.filter((s) =>
        currentStatuses.some(
          (cs) => cs.name.toLowerCase() === s.name.toLowerCase() && cs.sortOrder !== s.sortOrder,
        ),
      ),
    };

    const prefChanges: Record<string, { from: string | undefined; to: string }> = {};
    for (const [k, v] of Object.entries(config.workflowPreferences)) {
      if (currentSettings[k] !== v) {
        prefChanges[k] = { from: currentSettings[k], to: v };
      }
    }
    const strategyChanged =
      config.boardStrategy !== null &&
      JSON.stringify(config.boardStrategy) !== currentSettings[boardStrategyKey];

    const dryRun = c.req.query("dryRun") === "true";
    if (dryRun) {
      return c.json({
        dryRun: true,
        statusChanges,
        prefChanges,
        strategyChanged,
      });
    }

    // Apply statuses
    for (const s of statusChanges.toAdd) {
      await projectService.addStatus(projectId, s.name, s.sortOrder);
    }
    for (const s of statusChanges.toUpdate) {
      const existing = currentStatuses.find((cs) => cs.name.toLowerCase() === s.name.toLowerCase());
      if (existing) {
        await projectService.updateStatusSortOrder(projectId, existing.id, s.sortOrder);
      }
    }

    // Apply workflow preferences
    const prefsToApply: Record<string, string> = { ...config.workflowPreferences };

    // Apply board strategy
    if (config.boardStrategy !== null) {
      prefsToApply[boardStrategyKey] = JSON.stringify(config.boardStrategy);
    }

    if (Object.keys(prefsToApply).length > 0) {
      await preferenceService.updateSettings(prefsToApply);
    }

    return c.json({
      ok: true,
      statusChanges,
      prefChanges,
      strategyChanged,
    });
  });

  return router;
}
