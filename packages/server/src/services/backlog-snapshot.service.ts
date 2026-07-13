import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getProjectById, getProjectStatuses } from "../repositories/project.repository.js";
import { listMilestonesByProject } from "../repositories/milestone.repository.js";
import { getTagsForIssues, getDependenciesForIssues } from "../repositories/issue.repository.js";
import { getAllTags } from "../repositories/tag.repository.js";
import {
  getFullIssuesForProject,
  getExistingIssueNumbers,
  applyBacklogImport,
  type BacklogImportPlan,
  type BacklogImportResult,
} from "../repositories/backlog-snapshot.repository.js";

export const BACKLOG_SNAPSHOT_KIND = "agentic-kanban-backlog-snapshot";
export const BACKLOG_SNAPSHOT_VERSION = 1;

/**
 * A portable, LOSSLESS snapshot of a project's backlog for device-to-device
 * migration. Everything is keyed by NAME (status/milestone/tag) and by the
 * project-local issue NUMBER, never by internal ids, so it re-imports cleanly
 * into a differently-registered project. Excludes device-specific data
 * (workspaces, sessions, agent output) by design.
 */
export interface BacklogSnapshot {
  kind: typeof BACKLOG_SNAPSHOT_KIND;
  formatVersion: number;
  exportedAt: string;
  project: { name: string };
  statuses: { name: string; sortOrder: number; isDefault: boolean }[];
  milestones: { name: string; dueDate: string | null }[];
  tags: { name: string; color: string | null }[];
  issues: BacklogSnapshotIssue[];
  dependencies: BacklogSnapshotDependency[];
}

export interface BacklogSnapshotIssue {
  issueNumber: number | null;
  title: string;
  description: string | null;
  priority: string;
  issueType: string;
  sortOrder: number;
  status: string;
  milestone: string | null;
  estimate: string | null;
  dueDate: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  pinned: boolean;
  skipAutoReview: boolean;
  checklistJson: string | null;
  touchedFilesJson: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
}

export interface BacklogSnapshotDependency {
  fromNumber: number;
  toNumber: number;
  type: string;
}

/** Build the portable snapshot for a project. Throws if the project is unknown. */
export async function exportBacklogSnapshot(
  projectId: string,
  database: Database = db,
  opts: { now?: string } = {},
): Promise<BacklogSnapshot> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const [statusRows, milestoneRows, issueRows, allTags] = await Promise.all([
    getProjectStatuses(projectId, database),
    listMilestonesByProject(projectId, database),
    getFullIssuesForProject(projectId, database),
    getAllTags(database),
  ]);

  const statusNameById = new Map(statusRows.map((s) => [s.id, s.name]));
  const milestoneNameById = new Map(milestoneRows.map((m) => [m.id, m.name]));

  const issueIds = issueRows.map((r) => r.id);
  const [tagRows, depRows] = await Promise.all([
    getTagsForIssues(issueIds, database),
    getDependenciesForIssues(issueIds, database),
  ]);

  const tagsByIssue = new Map<string, string[]>();
  for (const tr of tagRows) {
    const list = tagsByIssue.get(tr.issueId) ?? [];
    list.push(tr.tagName);
    tagsByIssue.set(tr.issueId, list);
  }

  const idToNumber = new Map(issueRows.map((r) => [r.id, r.issueNumber]));
  const inProject = new Set(issueIds);

  const usedTagNames = new Set<string>();
  const issues: BacklogSnapshotIssue[] = issueRows.map((row) => {
    const names = tagsByIssue.get(row.id) ?? [];
    for (const n of names) usedTagNames.add(n);
    return {
      issueNumber: row.issueNumber,
      title: row.title,
      description: row.description,
      priority: row.priority,
      issueType: row.issueType,
      sortOrder: row.sortOrder,
      status: statusNameById.get(row.statusId) ?? "",
      milestone: row.milestoneId ? milestoneNameById.get(row.milestoneId) ?? null : null,
      estimate: row.estimate,
      dueDate: row.dueDate,
      externalKey: row.externalKey,
      externalUrl: row.externalUrl,
      pinned: row.pinned,
      skipAutoReview: row.skipAutoReview,
      checklistJson: row.checklistJson,
      touchedFilesJson: row.touchedFilesJson,
      tags: names,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      statusChangedAt: row.statusChangedAt,
    };
  });

  const dependencies: BacklogSnapshotDependency[] = [];
  for (const d of depRows) {
    // Only edges wholly within this project can be re-keyed by number.
    if (!inProject.has(d.dependsOnId)) continue;
    const fromNumber = idToNumber.get(d.issueId);
    const toNumber = idToNumber.get(d.dependsOnId);
    if (fromNumber == null || toNumber == null) continue;
    dependencies.push({ fromNumber, toNumber, type: d.type });
  }

  return {
    kind: BACKLOG_SNAPSHOT_KIND,
    formatVersion: BACKLOG_SNAPSHOT_VERSION,
    exportedAt: opts.now ?? new Date().toISOString(),
    project: { name: project.name },
    statuses: statusRows.map((s) => ({ name: s.name, sortOrder: s.sortOrder, isDefault: s.isDefault })),
    milestones: milestoneRows.map((m) => ({ name: m.name, dueDate: m.dueDate })),
    tags: allTags
      .filter((t) => usedTagNames.has(t.name))
      .map((t) => ({ name: t.name, color: t.color })),
    issues,
    dependencies,
  };
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asBool(v: unknown): boolean {
  return v === true;
}

/**
 * Validate + normalize an untrusted parsed JSON blob into a BacklogSnapshot.
 * Returns the coerced snapshot and a list of hard errors (non-empty => reject).
 * Tolerant of missing optional fields; strict about issues[] and titles.
 */
export function validateBacklogSnapshot(raw: unknown): { snapshot: BacklogSnapshot | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { snapshot: null, errors: ["Snapshot must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== undefined && obj.kind !== BACKLOG_SNAPSHOT_KIND) {
    const kindStr = typeof obj.kind === "string" ? obj.kind : JSON.stringify(obj.kind);
    errors.push(`Unexpected kind "${kindStr}" (expected "${BACKLOG_SNAPSHOT_KIND}")`);
  }
  if (!Array.isArray(obj.issues)) {
    errors.push("Snapshot.issues must be an array");
    return { snapshot: null, errors };
  }

  const statuses = Array.isArray(obj.statuses)
    ? obj.statuses.map((s, i) => {
        const so = (s ?? {}) as Record<string, unknown>;
        return { name: asString(so.name), sortOrder: asNumberOrNull(so.sortOrder) ?? i, isDefault: asBool(so.isDefault) };
      }).filter((s) => s.name)
    : [];

  const milestones = Array.isArray(obj.milestones)
    ? obj.milestones.map((m) => {
        const mo = (m ?? {}) as Record<string, unknown>;
        return { name: asString(mo.name), dueDate: asStringOrNull(mo.dueDate) };
      }).filter((m) => m.name)
    : [];

  const tags = Array.isArray(obj.tags)
    ? obj.tags.map((t) => {
        const to = (t ?? {}) as Record<string, unknown>;
        return { name: asString(to.name), color: asStringOrNull(to.color) };
      }).filter((t) => t.name)
    : [];

  const issues: BacklogSnapshotIssue[] = [];
  for (let i = 0; i < obj.issues.length; i++) {
    const io = (obj.issues[i] ?? {}) as Record<string, unknown>;
    const title = asString(io.title).trim();
    if (!title) {
      errors.push(`issues[${i}]: title is required`);
      continue;
    }
    const rawTags = Array.isArray(io.tags) ? io.tags.filter((t): t is string => typeof t === "string") : [];
    const rawType = io.issueType ?? io.type;
    issues.push({
      issueNumber: asNumberOrNull(io.issueNumber),
      title,
      description: asStringOrNull(io.description),
      priority: asString(io.priority, "medium") || "medium",
      issueType: asString(rawType, "task") || "task",
      sortOrder: asNumberOrNull(io.sortOrder) ?? 0,
      status: asString(io.status),
      milestone: asStringOrNull(io.milestone),
      estimate: asStringOrNull(io.estimate),
      dueDate: asStringOrNull(io.dueDate),
      externalKey: asStringOrNull(io.externalKey),
      externalUrl: asStringOrNull(io.externalUrl),
      pinned: asBool(io.pinned),
      skipAutoReview: asBool(io.skipAutoReview),
      checklistJson: asStringOrNull(io.checklistJson),
      touchedFilesJson: asStringOrNull(io.touchedFilesJson),
      tags: rawTags,
      createdAt: asString(io.createdAt) || new Date(0).toISOString(),
      updatedAt: asString(io.updatedAt) || new Date(0).toISOString(),
      statusChangedAt: asStringOrNull(io.statusChangedAt),
    });
  }

  if (errors.length > 0) return { snapshot: null, errors };

  const dependencies: BacklogSnapshotDependency[] = Array.isArray(obj.dependencies)
    ? obj.dependencies
        .map((d) => {
          const dep = (d ?? {}) as Record<string, unknown>;
          return { fromNumber: asNumberOrNull(dep.fromNumber), toNumber: asNumberOrNull(dep.toNumber), type: asString(dep.type, "depends_on") || "depends_on" };
        })
        .filter((d): d is BacklogSnapshotDependency => d.fromNumber != null && d.toNumber != null)
    : [];

  return {
    snapshot: {
      kind: BACKLOG_SNAPSHOT_KIND,
      formatVersion: asNumberOrNull(obj.formatVersion) ?? BACKLOG_SNAPSHOT_VERSION,
      exportedAt: asString(obj.exportedAt) || new Date(0).toISOString(),
      project: { name: asString((obj.project as Record<string, unknown> | undefined)?.name) },
      statuses,
      milestones,
      tags,
      issues,
      dependencies,
    },
    errors: [],
  };
}

/**
 * Import a snapshot into the target project. De-conflicts issue numbers against
 * the target (preserves a number when free, otherwise allocates the next free
 * one), remaps statuses/milestones/tags by name (creating any missing), and
 * rewires dependencies. Idempotent it is NOT — importing twice duplicates issues.
 */
export async function importBacklogSnapshot(
  projectId: string,
  snapshot: BacklogSnapshot,
  database: Database = db,
): Promise<BacklogImportResult> {
  const existing = new Set(await getExistingIssueNumbers(projectId, database));
  let nextFree = (existing.size > 0 ? Math.max(...existing) : 0) + 1;
  const renumbered: string[] = [];

  const planIssues = snapshot.issues.map((issue) => {
    let number = issue.issueNumber;
    if (number == null || existing.has(number)) {
      const original = number;
      number = nextFree;
      while (existing.has(number)) number++;
      nextFree = number + 1;
      renumbered.push(`#${original ?? "?"} -> #${number}`);
    }
    existing.add(number);
    return {
      issueNumber: number,
      sourceNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      issueType: issue.issueType,
      sortOrder: issue.sortOrder,
      statusName: issue.status,
      milestoneName: issue.milestone,
      estimate: issue.estimate,
      dueDate: issue.dueDate,
      externalKey: issue.externalKey,
      externalUrl: issue.externalUrl,
      pinned: issue.pinned,
      skipAutoReview: issue.skipAutoReview,
      checklistJson: issue.checklistJson,
      touchedFilesJson: issue.touchedFilesJson,
      tagNames: issue.tags,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      statusChangedAt: issue.statusChangedAt,
    };
  });

  // Tags to create = explicit snapshot.tags plus any referenced on issues.
  const tagColors = new Map(snapshot.tags.map((t) => [t.name, t.color]));
  const tagNames = new Set<string>(snapshot.tags.map((t) => t.name));
  for (const issue of snapshot.issues) for (const t of issue.tags) tagNames.add(t);

  const plan: BacklogImportPlan = {
    projectId,
    newStatuses: snapshot.statuses.map((s) => ({ name: s.name, sortOrder: s.sortOrder })),
    newTags: [...tagNames].map((name) => ({ name, color: tagColors.get(name) ?? null })),
    newMilestones: snapshot.milestones.map((m) => ({ name: m.name, dueDate: m.dueDate })),
    issues: planIssues,
    dependencies: snapshot.dependencies.map((d) => ({ fromSourceNumber: d.fromNumber, toSourceNumber: d.toNumber, type: d.type })),
  };

  const result = await applyBacklogImport(plan, database);
  if (renumbered.length > 0) {
    result.warnings.push(`Renumbered ${renumbered.length} issue(s) to avoid collisions: ${renumbered.join(", ")}`);
  }
  return result;
}
