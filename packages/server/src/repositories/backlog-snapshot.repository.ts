import { issues, issueTags, issueDependencies, tags, milestones, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, withTransaction } from "../db/index.js";
import type { Database } from "../db/index.js";

/** All full issue rows for a project, ordered by sort order then issue number — export source. */
export async function getFullIssuesForProject(projectId: string, database: Database = db) {
  return database
    .select()
    .from(issues)
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.sortOrder, issues.issueNumber);
}

/** The set of issue numbers already used in a project (import collision detection). */
export async function getExistingIssueNumbers(projectId: string, database: Database = db): Promise<number[]> {
  const rows = await database
    .select({ n: issues.issueNumber })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  return rows.map((r) => r.n).filter((n): n is number => n !== null);
}

/** A single issue as it should be inserted on import (ids assigned by the writer). */
export interface BacklogImportIssue {
  /** The number to persist (already de-conflicted against the target project). */
  issueNumber: number;
  /** The snapshot's original number — used only to resolve dependency endpoints. */
  sourceNumber: number | null;
  title: string;
  description: string | null;
  priority: string;
  issueType: string;
  sortOrder: number;
  /** Status name (case-insensitively resolved to a target status id by the writer). */
  statusName: string;
  /** Milestone name or null (resolved to a target milestone id by the writer). */
  milestoneName: string | null;
  estimate: string | null;
  dueDate: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  pinned: boolean;
  skipAutoReview: boolean;
  checklistJson: string | null;
  touchedFilesJson: string | null;
  tagNames: string[];
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
}

export interface BacklogImportPlan {
  projectId: string;
  /** Statuses to create in the target (missing by name), with their sort order. */
  newStatuses: { name: string; sortOrder: number }[];
  /** Tags to create globally (missing by name). */
  newTags: { name: string; color: string | null }[];
  /** Milestones to create in the target project (missing by name). */
  newMilestones: { name: string; dueDate: string | null }[];
  issues: BacklogImportIssue[];
  /** Dependency edges keyed by the snapshot's original issue numbers. */
  dependencies: { fromSourceNumber: number; toSourceNumber: number; type: string }[];
}

export interface BacklogImportResult {
  createdIssues: number;
  createdStatuses: string[];
  createdTags: string[];
  createdMilestones: string[];
  createdDependencies: number;
  skippedDependencies: number;
  warnings: string[];
}

/**
 * Apply a resolved import plan atomically: create any missing statuses/tags/
 * milestones, insert every issue (remapping status/milestone names to the
 * target's ids), attach tags, and wire dependencies by the snapshot's original
 * issue numbers. All-or-nothing via a single transaction.
 */
export async function applyBacklogImport(
  plan: BacklogImportPlan,
  database: Database = db,
): Promise<BacklogImportResult> {
  return withTransaction(database, async (tx) => {
    const warnings: string[] = [];
    const now = new Date().toISOString();

    // --- Resolve status ids (existing + newly created), keyed case-insensitively.
    const statusByName = new Map<string, string>();
    const existingStatuses = await tx
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, plan.projectId));
    for (const s of existingStatuses) statusByName.set(s.name.toLowerCase(), s.id);

    const createdStatuses: string[] = [];
    for (const s of plan.newStatuses) {
      if (statusByName.has(s.name.toLowerCase())) continue;
      const id = randomUUID();
      await tx.insert(projectStatuses).values({
        id,
        projectId: plan.projectId,
        name: s.name,
        sortOrder: s.sortOrder,
        createdAt: now,
      });
      statusByName.set(s.name.toLowerCase(), id);
      createdStatuses.push(s.name);
    }

    // A fallback status for issues whose status name can't be resolved.
    const fallbackStatusId: string = existingStatuses[0]?.id ?? [...statusByName.values()][0] ?? "";

    // --- Resolve tag ids (existing + newly created).
    const tagByName = new Map<string, string>();
    const existingTags = await tx.select({ id: tags.id, name: tags.name }).from(tags);
    for (const t of existingTags) tagByName.set(t.name.toLowerCase(), t.id);

    const createdTags: string[] = [];
    for (const t of plan.newTags) {
      if (tagByName.has(t.name.toLowerCase())) continue;
      const id = randomUUID();
      await tx.insert(tags).values({ id, name: t.name, color: t.color ?? null, createdAt: now });
      tagByName.set(t.name.toLowerCase(), id);
      createdTags.push(t.name);
    }

    // --- Resolve milestone ids (existing + newly created).
    const milestoneByName = new Map<string, string>();
    const existingMilestones = await tx
      .select({ id: milestones.id, name: milestones.name })
      .from(milestones)
      .where(eq(milestones.projectId, plan.projectId));
    for (const m of existingMilestones) milestoneByName.set(m.name.toLowerCase(), m.id);

    const createdMilestones: string[] = [];
    for (const m of plan.newMilestones) {
      if (milestoneByName.has(m.name.toLowerCase())) continue;
      const id = randomUUID();
      await tx.insert(milestones).values({ id, projectId: plan.projectId, name: m.name, dueDate: m.dueDate ?? null, createdAt: now });
      milestoneByName.set(m.name.toLowerCase(), id);
      createdMilestones.push(m.name);
    }

    // --- Insert issues, building sourceNumber -> newIssueId for dependency wiring.
    const idBySourceNumber = new Map<number, string>();
    const tagEntries: { id: string; issueId: string; tagId: string }[] = [];
    let createdIssues = 0;

    for (const issue of plan.issues) {
      const issueId = randomUUID();
      const statusId = statusByName.get(issue.statusName.toLowerCase()) ?? fallbackStatusId;
      if (statusByName.get(issue.statusName.toLowerCase()) === undefined) {
        warnings.push(`Issue "${issue.title}": status "${issue.statusName}" not found — placed in fallback status.`);
      }
      const milestoneId = issue.milestoneName ? milestoneByName.get(issue.milestoneName.toLowerCase()) ?? null : null;

      await tx.insert(issues).values({
        id: issueId,
        issueNumber: issue.issueNumber,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        issueType: issue.issueType,
        sortOrder: issue.sortOrder,
        statusId,
        projectId: plan.projectId,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        statusChangedAt: issue.statusChangedAt,
        skipAutoReview: issue.skipAutoReview,
        estimate: issue.estimate,
        dueDate: issue.dueDate,
        externalKey: issue.externalKey,
        externalUrl: issue.externalUrl,
        touchedFilesJson: issue.touchedFilesJson,
        checklistJson: issue.checklistJson,
        pinned: issue.pinned,
        milestoneId,
      });
      createdIssues++;
      if (issue.sourceNumber !== null) idBySourceNumber.set(issue.sourceNumber, issueId);

      for (const tagName of issue.tagNames) {
        const tagId = tagByName.get(tagName.toLowerCase());
        if (tagId) tagEntries.push({ id: randomUUID(), issueId, tagId });
      }
    }

    if (tagEntries.length > 0) await tx.insert(issueTags).values(tagEntries);

    // --- Wire dependencies by source number; dedupe and drop unresolved endpoints.
    let createdDependencies = 0;
    let skippedDependencies = 0;
    const seen = new Set<string>();
    for (const dep of plan.dependencies) {
      const issueId = idBySourceNumber.get(dep.fromSourceNumber);
      const dependsOnId = idBySourceNumber.get(dep.toSourceNumber);
      if (!issueId || !dependsOnId || issueId === dependsOnId) {
        skippedDependencies++;
        continue;
      }
      const key = `${issueId}|${dependsOnId}|${dep.type}`;
      if (seen.has(key)) {
        skippedDependencies++;
        continue;
      }
      seen.add(key);
      await tx.insert(issueDependencies).values({
        id: randomUUID(),
        issueId,
        dependsOnId,
        type: dep.type as (typeof issueDependencies.$inferInsert)["type"],
        createdAt: now,
      });
      createdDependencies++;
    }

    return {
      createdIssues,
      createdStatuses,
      createdTags,
      createdMilestones,
      createdDependencies,
      skippedDependencies,
      warnings,
    };
  }, "backlog-import");
}
