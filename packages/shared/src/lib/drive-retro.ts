// Per-drive retro generation (#804).
//
// At drive completion, generate `docs/board-runs/<project>.md` from the drive's
// TELEMETRY rather than hand-authoring it (as `docs/board-runs/pulse-crm.md` was).
// The telemetry is everything already recorded for the project, scoped to the
// drive's window (`startedAt`..`finishedAt`):
//   - N/N done       — issues for the project (Done vs total, incl. the meta ticket)
//   - providers      — distinct executors across the drive's builder/review sessions
//   - cost           — summed `totalCostUsd` from session stats
//   - cold-build     — the latest `smoke_check` board-health event in the window
//   - obstacles      — `error`-type board-health events in the window
//   - cascade events — `launch`/`merge`-category board-health events in the window
//
// Lives in `shared` (the single-source-of-truth pattern, like git-service and
// workflow-engine) so both the server's REST finish path and the MCP `finish_drive`
// tool generate the same doc from one implementation. The query layer
// (gatherDriveTelemetry) is separated from the pure markdown renderer
// (renderDriveRetro) so both are independently unit-testable, and the file write is
// injectable so generation can be exercised without touching disk.

import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../schema/index.js";

export type DriveRetroDb = LibSQLDatabase<typeof schema>;

/** The drive fields the retro generator reads. */
export interface DriveRetroInput {
  id: string;
  projectId: string;
  metaIssueId: string | null;
  target: string;
  completionContract: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface DriveRetroTelemetry {
  driveId: string;
  projectName: string;
  projectSlug: string;
  repoPath: string;
  target: string;
  completionContract: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** Issue completion: Done vs total seeded for the project. */
  issuesTotal: number;
  issuesDone: number;
  /** The meta/epic ticket, if linked, and whether it reached Done. */
  meta: { issueNumber: number | null; title: string; done: boolean } | null;
  /** Distinct providers (session executors) used across the drive window, with session counts. */
  providers: Array<{ name: string; sessions: number }>;
  /** Summed agent cost (USD) across the drive window. */
  totalCostUsd: number;
  /** Total agent sessions counted in the window. */
  sessionCount: number;
  /** Latest cold-build / smoke-check signal recorded in the window. */
  coldBuild: { result: string; summary: string } | null;
  /** Obstacles surfaced in the window (error-type events). */
  obstacles: Array<{ issueNumber: number | null; summary: string }>;
  /** Cascade events in the window (launch/merge actions). */
  cascadeEvents: Array<{ issueNumber: number | null; category: string; summary: string }>;
}

/** Slugify a project name for the retro filename (`docs/board-runs/<slug>.md`). */
export function projectSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function parseCostUsd(stats: string | null): number {
  if (!stats) return 0;
  try {
    const p = JSON.parse(stats) as Record<string, unknown>;
    const c = p.totalCostUsd;
    return typeof c === "number" && Number.isFinite(c) ? c : 0;
  } catch {
    return 0;
  }
}

/**
 * Gather every telemetry signal for a drive, scoped to its time window. Pure read:
 * no writes, no LLM. The window is `startedAt`..`finishedAt` (open-ended if the
 * drive has no finish stamp yet — caller stamps it before generating).
 */
export async function gatherDriveTelemetry(
  drive: DriveRetroInput,
  database: DriveRetroDb,
): Promise<DriveRetroTelemetry | null> {
  const projectRows = await database
    .select({ name: schema.projects.name, repoPath: schema.projects.repoPath })
    .from(schema.projects)
    .where(eq(schema.projects.id, drive.projectId))
    .limit(1);
  if (projectRows.length === 0) return null;
  const project = projectRows[0];

  const windowEnd = drive.finishedAt ?? new Date().toISOString();

  // --- N/N done (issues for the project) ---
  const statusRows = await database
    .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.projectId, drive.projectId));
  const doneStatusIds = new Set(statusRows.filter((s) => s.name === "Done").map((s) => s.id));

  const issueRows = await database
    .select({
      id: schema.issues.id,
      issueNumber: schema.issues.issueNumber,
      title: schema.issues.title,
      statusId: schema.issues.statusId,
    })
    .from(schema.issues)
    .where(eq(schema.issues.projectId, drive.projectId));
  const issuesTotal = issueRows.length;
  const issuesDone = issueRows.filter((i) => doneStatusIds.has(i.statusId)).length;

  let meta: DriveRetroTelemetry["meta"] = null;
  if (drive.metaIssueId) {
    const m = issueRows.find((i) => i.id === drive.metaIssueId);
    if (m) meta = { issueNumber: m.issueNumber, title: m.title, done: doneStatusIds.has(m.statusId) };
  }

  // --- providers + cost (sessions in the drive window for this project) ---
  // sessions -> workspaces -> issues (project scoping); window-filter on startedAt.
  let providers: DriveRetroTelemetry["providers"] = [];
  let totalCostUsd = 0;
  let sessionCount = 0;
  const issueIds = issueRows.map((i) => i.id);
  if (issueIds.length > 0) {
    const wsRows = await database
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(inArray(schema.workspaces.issueId, issueIds));
    const wsIds = wsRows.map((w) => w.id);
    if (wsIds.length > 0) {
      const sessionRows = await database
        .select({ executor: schema.sessions.executor, stats: schema.sessions.stats })
        .from(schema.sessions)
        .where(
          and(
            inArray(schema.sessions.workspaceId, wsIds),
            gte(schema.sessions.startedAt, drive.startedAt),
            lte(schema.sessions.startedAt, windowEnd),
          ),
        );
      sessionCount = sessionRows.length;
      const byProvider = new Map<string, number>();
      for (const s of sessionRows) {
        const name = s.executor || "unknown";
        byProvider.set(name, (byProvider.get(name) ?? 0) + 1);
        totalCostUsd += parseCostUsd(s.stats);
      }
      providers = [...byProvider.entries()]
        .map(([name, count]) => ({ name, sessions: count }))
        .sort((a, b) => b.sessions - a.sessions);
    }
  }

  // --- board-health events in the window (obstacles, cold-build, cascade) ---
  const eventRows = await database
    .select({
      eventType: schema.boardHealthEvents.eventType,
      category: schema.boardHealthEvents.category,
      issueNumber: schema.boardHealthEvents.issueNumber,
      summary: schema.boardHealthEvents.summary,
      createdAt: schema.boardHealthEvents.createdAt,
    })
    .from(schema.boardHealthEvents)
    .where(
      and(
        eq(schema.boardHealthEvents.projectId, drive.projectId),
        gte(schema.boardHealthEvents.createdAt, drive.startedAt),
        lte(schema.boardHealthEvents.createdAt, windowEnd),
      ),
    )
    .orderBy(asc(schema.boardHealthEvents.createdAt));

  const obstacles = eventRows
    .filter((e) => e.eventType === "error")
    .map((e) => ({ issueNumber: e.issueNumber, summary: e.summary }));

  // The cold-build signal is the latest smoke_check event in the window.
  const smoke = [...eventRows].reverse().find((e) => e.category === "smoke_check");
  const coldBuild = smoke
    ? { result: smoke.eventType === "error" ? "FAILED" : "passed", summary: smoke.summary }
    : null;

  const cascadeEvents = eventRows
    .filter((e) => (e.category === "launch" || e.category === "merge") && e.eventType !== "error")
    .map((e) => ({ issueNumber: e.issueNumber, category: e.category as string, summary: e.summary }));

  return {
    driveId: drive.id,
    projectName: project.name,
    projectSlug: projectSlug(project.name),
    repoPath: project.repoPath,
    target: drive.target,
    completionContract: drive.completionContract,
    status: drive.status,
    startedAt: drive.startedAt,
    finishedAt: drive.finishedAt,
    issuesTotal,
    issuesDone,
    meta,
    providers,
    totalCostUsd,
    sessionCount,
    coldBuild,
    obstacles,
    cascadeEvents,
  };
}

/** Render the gathered telemetry into the `docs/board-runs/<project>.md` markdown. Pure. */
export function renderDriveRetro(t: DriveRetroTelemetry): string {
  const date = (t.finishedAt ?? t.startedAt).slice(0, 10);
  const lines: string[] = [];

  lines.push(`# Board run — ${t.projectName}`);
  lines.push("");
  lines.push(`> Auto-generated from drive telemetry at completion (#804). Drive \`${t.driveId}\`.`);
  lines.push("");
  lines.push(`**Date:** ${date}`);
  lines.push(`**Project:** \`${t.projectName}\` — repo \`${t.repoPath}\``);
  lines.push(`**Target:** ${t.target}`);
  if (t.completionContract) lines.push(`**Completion contract:** ${t.completionContract}`);
  lines.push(`**Status:** ${t.status}`);
  lines.push(`**Window:** ${t.startedAt} → ${t.finishedAt ?? "(open)"}`);
  lines.push("");

  // Outcome
  lines.push("## Outcome");
  lines.push("");
  lines.push(`- **${t.issuesDone}/${t.issuesTotal} Done.** (issue completion across the project)`);
  if (t.meta) {
    const metaRef = t.meta.issueNumber != null ? `#${t.meta.issueNumber} ` : "";
    lines.push(`- Meta/epic ticket ${metaRef}(${t.meta.title}): ${t.meta.done ? "Done" : "NOT Done"}.`);
  }
  if (t.coldBuild) {
    lines.push(`- **Cold build:** ${t.coldBuild.result} — ${t.coldBuild.summary}`);
  } else {
    lines.push("- **Cold build:** not recorded (no smoke-check event in the drive window).");
  }
  lines.push("");

  // Providers + cost
  lines.push("## Providers & cost");
  lines.push("");
  if (t.providers.length > 0) {
    for (const p of t.providers) {
      lines.push(`- \`${p.name}\` — ${p.sessions} session${p.sessions === 1 ? "" : "s"}`);
    }
  } else {
    lines.push("- (no agent sessions recorded in the drive window)");
  }
  lines.push(
    `- **Total agent cost:** $${t.totalCostUsd.toFixed(2)} across ${t.sessionCount} session${t.sessionCount === 1 ? "" : "s"}`,
  );
  lines.push("");

  // Cascade events
  lines.push("## Cascade events");
  lines.push("");
  if (t.cascadeEvents.length > 0) {
    for (const e of t.cascadeEvents) {
      const ref = e.issueNumber != null ? `#${e.issueNumber} ` : "";
      lines.push(`- _${e.category}_ ${ref}— ${e.summary}`);
    }
  } else {
    lines.push("- (none recorded)");
  }
  lines.push("");

  // Obstacles
  lines.push("## Obstacles");
  lines.push("");
  if (t.obstacles.length > 0) {
    for (const o of t.obstacles) {
      const ref = o.issueNumber != null ? `#${o.issueNumber} ` : "";
      lines.push(`- ${ref}${o.summary}`);
    }
  } else {
    lines.push("- (none recorded — clean drive)");
  }
  lines.push("");

  return lines.join("\n");
}

/** Absolute path the retro doc is written to for a project: `<repoPath>/docs/board-runs/<slug>.md`. */
export function driveRetroPath(repoPath: string, slug: string): string {
  return join(repoPath, "docs", "board-runs", `${slug}.md`);
}

export interface GenerateDriveRetroResult {
  path: string;
  content: string;
}

/**
 * Generate the retro doc for a completed drive: gather telemetry, render markdown,
 * write `docs/board-runs/<project>.md` under the project's repo. Best-effort and
 * injectable: `writeFile`/`mkdir` are overridable for tests. Returns the written
 * path + content, or null if the drive's project/repo can't be resolved.
 *
 * Guards on the repo actually existing on disk so a project whose repoPath is a
 * fixture/never-checked-out path is a clean no-op (no stray dirs) — a real
 * registered project's repo always exists. Pass `exists: () => true` (or an
 * injected `writeFile`) to bypass the check in tests.
 */
export async function generateDriveRetro(
  drive: DriveRetroInput,
  database: DriveRetroDb,
  deps: {
    writeFile?: (path: string, content: string) => Promise<void>;
    mkdir?: (dir: string) => Promise<void>;
    exists?: (path: string) => boolean;
  } = {},
): Promise<GenerateDriveRetroResult | null> {
  const telemetry = await gatherDriveTelemetry(drive, database);
  if (!telemetry || !telemetry.repoPath) return null;

  // No-op (not an error) when the repo dir doesn't exist — only relevant when
  // writing to disk for real; an injected writeFile means the caller controls I/O.
  const exists = deps.exists ?? existsSync;
  if (!deps.writeFile && !exists(telemetry.repoPath)) return null;

  const content = renderDriveRetro(telemetry);
  const path = driveRetroPath(telemetry.repoPath, telemetry.projectSlug);

  const write = deps.writeFile ?? ((p, c) => fsWriteFile(p, c, "utf8"));
  const makeDir = deps.mkdir ?? ((d) => mkdir(d, { recursive: true }).then(() => undefined));

  await makeDir(dirname(path));
  await write(path, content);
  return { path, content };
}
