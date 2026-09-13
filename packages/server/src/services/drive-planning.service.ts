import { randomUUID } from "node:crypto";
import type { DrivePlanResult, DriveExtendResult } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getDriveById, updateDrive } from "../repositories/drive.repository.js";
import { nextIssueNumber } from "../repositories/issue-number.repository.js";
import * as repo from "../repositories/issue-ai.repository.js";
import { DriveError } from "./drive.service.js";
import { decomposeEpic } from "./issue-ai.service.js";

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
 * creates ONE issue from the target and links the drive to it. By default it generates no
 * children and calls no model — the caller's next step is the ordinary `/decompose` ->
 * `/decompose/confirm` pair, which is the reviewed propose->confirm path the rest of the board
 * already uses. Nothing here is a second way to CREATE an epic's children; `decompose: true`
 * (#1133) only fetches the SAME `/decompose` proposal in the same request, so the caller can
 * land straight on the reviewable preview — confirming still goes through the unchanged
 * `/decompose/confirm` endpoint, so nothing is created without a human pressing confirm.
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
 * Fetch the `/decompose` proposal for a just-(re)confirmed epic, folding any failure into
 * `undefined` rather than throwing (#1133's acceptance: a failed decomposition still returns
 * the created/existing epic, never fails the whole `plan` request).
 */
async function tryProposeDecomposition(
  issueId: string,
  projectId: string,
  database: Database,
): Promise<DrivePlanResult["proposal"] | undefined> {
  try {
    return await decomposeEpic(issueId, projectId, database);
  } catch {
    return undefined;
  }
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
  options: { decompose?: boolean } = {},
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
      const proposal = options.decompose
        ? await tryProposeDecomposition(existing.id, projectId, database)
        : undefined;
      return {
        issue: {
          id: existing.id,
          issueNumber: existing.issueNumber,
          title: existing.title,
          projectId,
        },
        existing: true,
        ...(proposal ? { proposal } : {}),
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

  const proposal = options.decompose
    ? await tryProposeDecomposition(id, projectId, database)
    : undefined;

  return {
    issue: { id, issueNumber, title, projectId },
    existing: false,
    ...(proposal ? { proposal } : {}),
  };
}

/** Matches `## Increment <N>` headings already in an epic body, to number the next one. */
const INCREMENT_HEADING_RE = /^## Increment (\d+)\s*$/gm;

/** Next increment number for an epic body: one past the highest `## Increment N` found. */
export function nextIncrementNumber(description: string | null): number {
  let max = 0;
  for (const match of (description ?? "").matchAll(INCREMENT_HEADING_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * Extend a drive (#1132) — re-enter a drive, active or completed, with a one-line addendum.
 *
 * A drive is meant to be the consistent entry point for a feature dimension: come back and
 * extend it, even when parts (or all) of it already shipped. Before this, a drive was
 * one-shot — `reconcileDriveCompletion` marks it `completed` once its children close, and
 * nothing reopened it. `driveService.update` already allows reactivation (status "active"
 * clears `finishedAt`), so the state machine allowed it; there was just no action wired to it.
 *
 * This appends the addendum to the epic's description as a new `## Increment N` section (the
 * epic stays the SINGLE scope record — never a rival epic, the same idempotence argument
 * `planDrive` makes), reactivates the drive when it was completed, and leaves an active
 * drive's status untouched. The retro written at finish time lives in a separate file
 * (`generateDriveRetro`) and is untouched by this — extending a completed drive must not
 * erase the record of the increment that closed it.
 */
export async function extendDrive(
  projectId: string,
  driveId: string,
  addendum: string,
  database: Database,
): Promise<DriveExtendResult> {
  const trimmed = addendum.trim();
  if (!trimmed) throw new DriveError("addendum is required", "BAD_REQUEST");

  const drive = await getDriveById(driveId, database);
  if (!drive) throw new DriveError("Drive not found", "NOT_FOUND");
  if (drive.projectId !== projectId) {
    throw new DriveError("Drive does not belong to this project", "FORBIDDEN");
  }
  if (!drive.metaIssueId) {
    throw new DriveError("Drive has no epic yet — plan it before extending", "BAD_REQUEST");
  }

  const epic = await repo.getIssueBasics(drive.metaIssueId, database);
  if (!epic) {
    throw new DriveError("Drive's epic issue no longer exists", "BAD_REQUEST");
  }

  const increment = nextIncrementNumber(epic.description);
  const now = new Date().toISOString();
  const newDescription = `${(epic.description ?? "").trimEnd()}\n\n## Increment ${increment}\n\n${trimmed}`;
  await repo.updateIssueDescription(epic.id, newDescription, now, database);

  const wasCompleted = drive.status !== "active";
  if (wasCompleted) {
    await updateDrive(driveId, { status: "active", finishedAt: null }, database);
  }

  const updatedDrive = await getDriveById(driveId, database);
  if (!updatedDrive) throw new DriveError("Drive not found", "NOT_FOUND");

  return {
    drive: updatedDrive,
    issue: { id: epic.id, issueNumber: epic.issueNumber, title: epic.title, projectId },
    increment,
    reactivated: wasCompleted,
  };
}
