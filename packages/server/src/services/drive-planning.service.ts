import { randomUUID } from "node:crypto";
import type { DrivePlanResult } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getDriveById, updateDrive } from "../repositories/drive.repository.js";
import { nextIssueNumber } from "../repositories/issue-number.repository.js";
import * as repo from "../repositories/issue-ai.repository.js";
import { DriveError } from "./drive.service.js";

/**
 * Plan a drive from its TARGET (#1072).
 *
 * A drive's scope is its meta/epic issue and that issue's `parent_of` children — so a drive
 * started with only a target sentence has no scope, and had no way to acquire one: the only
 * populated path ran the other way round (create an epic, decompose it, and let
 * `confirmEpicDecomposition`'s `driveTarget` auto-create the drive record). Started from the
 * Drive view, the dashboard told the operator to "link a meta/epic issue with children to this
 * drive" — an action the board offered nowhere. `drive-dashboard.service.ts` even referred to a
 * "drive-epic seeder"; no such thing was ever written.
 *
 * This is that seeder, and it is deliberately the *smallest* thing that unblocks the flow: it
 * creates ONE issue from the target and links the drive to it. It generates no children and
 * calls no model — the caller's next step is the ordinary `/decompose` -> `/decompose/confirm`
 * pair, which is the reviewed propose->confirm path the rest of the board already uses. Nothing
 * here is a second way to fan out an epic.
 *
 * **Idempotent by design.** A drive has exactly one meta issue, and planning a drive that
 * already has one returns it with `existing: true` rather than creating a rival epic — a second
 * epic would silently split the drive's scope, since the dashboard reads only `metaIssueId`.
 */

/**
 * Longest epic title we will mint from a target sentence.
 *
 * A target is prose ("Create a valid jira integration sync with all expected parts as a
 * plugin, extend the plugin system as needed") and lands in board cards, the tier graph and
 * commit subjects, so it is truncated at a word boundary. The FULL target is always preserved
 * verbatim in the description, so nothing is lost by the trim.
 */
export const MAX_EPIC_TITLE_LENGTH = 100;

/** Truncate at the last word boundary that fits, falling back to a hard cut. */
export function deriveEpicTitle(target: string): string {
  const clean = target.trim().replace(/\s+/g, " ");
  if (clean.length <= MAX_EPIC_TITLE_LENGTH) return clean;
  const cut = clean.slice(0, MAX_EPIC_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  // A target with no space in its first 100 chars (a URL, a pasted identifier) has no word
  // boundary to prefer, so the hard cut is the honest answer rather than an empty title.
  const base = lastSpace > MAX_EPIC_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s,.;:-]+$/, "")}…`;
}

/**
 * The epic body. The target is restated in full (the title may be truncated) and the
 * completion contract, when the drive carries one, becomes the acceptance criteria — that is
 * exactly what a contract is, and repeating it here is what puts it in front of the decomposer
 * and every builder that later reads a child.
 */
export function buildEpicDescription(target: string, completionContract: string | null): string {
  const sections = [`## Drive target\n\n${target.trim()}`];
  if (completionContract?.trim()) {
    sections.push(`## Completion contract\n\n${completionContract.trim()}`);
  }
  sections.push(
    "_Seeded from a drive by `POST /api/projects/:projectId/drives/:id/plan`. Decompose this " +
      "epic to fill the drive's backlog; its children become the drive's scope._",
  );
  return sections.join("\n\n");
}

/**
 * Create (or return) the meta/epic issue that scopes a drive.
 *
 * The epic is created in the project's Backlog column so it is visible as unstarted work and
 * is NOT picked up by an auto-start pass before it has been decomposed.
 */
export async function planDrive(
  projectId: string,
  driveId: string,
  database: Database,
): Promise<DrivePlanResult> {
  const drive = await getDriveById(driveId, database);
  if (!drive) throw new DriveError("Drive not found", "NOT_FOUND");
  if (drive.projectId !== projectId) {
    throw new DriveError("Drive does not belong to this project", "FORBIDDEN");
  }

  if (drive.metaIssueId) {
    // No dangling-pointer branch is needed: `drives.meta_issue_id` is `on delete set null`,
    // so deleting the epic RELEASES the drive rather than leaving a stale id behind, and the
    // drive is plannable again by the ordinary path.
    const existing = await repo.getIssueBasics(drive.metaIssueId, database);
    if (existing) {
      return {
        issue: {
          id: existing.id,
          issueNumber: existing.issueNumber,
          title: existing.title,
          projectId,
        },
        existing: true,
      };
    }
  }

  const statusId =
    (await repo.getStatusIdByName(projectId, "Backlog", database)) ??
    (await repo.getDefaultStatusId(projectId, database));
  if (!statusId) throw new DriveError("No statuses found for project", "BAD_REQUEST");

  const now = new Date().toISOString();
  const id = randomUUID();
  const issueNumber = await nextIssueNumber(projectId, database);
  const title = deriveEpicTitle(drive.target);

  await repo.insertChildIssue(
    {
      id,
      issueNumber,
      title,
      description: buildEpicDescription(drive.target, drive.completionContract),
      priority: "high",
      issueType: "feature",
      skipAutoReview: false,
      estimate: null,
      sortOrder: 0,
      statusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    },
    database,
  );

  // Tag it `epic` exactly as `confirmEpicDecomposition` does, so a planned epic and a
  // hand-decomposed one are indistinguishable to every consumer of that tag.
  let epicTag = await repo.getTagByName("epic", database);
  if (epicTag.length === 0) {
    const tagId = randomUUID();
    await repo.insertTag(
      { id: tagId, name: "epic", color: "#8B5CF6", isBuiltin: true, createdAt: now },
      database,
    );
    epicTag = [{ id: tagId }];
  }
  await repo.insertIssueTag({ id: randomUUID(), issueId: id, tagId: epicTag[0].id }, database);

  await updateDrive(driveId, { metaIssueId: id }, database);

  return { issue: { id, issueNumber, title, projectId }, existing: false };
}
