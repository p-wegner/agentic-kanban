import { randomUUID } from "node:crypto";
import { redDebt } from "@agentic-kanban/shared/schema";
import type { RedDebtTag } from "@agentic-kanban/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export type RedDebtRow = typeof redDebt.$inferSelect;

export interface OpenRedDebtEntryInput {
  projectId: string;
  suite: string;
  sinceCommit: string;
  attributedIssueId?: string | null;
  ownerIssueId?: string | null;
  tag: RedDebtTag;
  now?: string;
}

/** The currently OPEN (unresolved) entry for a project's suite, or null. */
export async function getOpenRedDebtEntry(
  projectId: string,
  suite: string,
  database: Database = db,
): Promise<RedDebtRow | null> {
  return firstRow(
    database
      .select()
      .from(redDebt)
      .where(and(eq(redDebt.projectId, projectId), eq(redDebt.suite, suite), isNull(redDebt.resolvedAt))),
  );
}

/**
 * Open (or refresh) a red-debt ledger entry for a project's suite.
 *
 * One OPEN row per (project, suite) — an already-open entry is returned as-is rather than
 * duplicated (the ledger tracks "is this suite red right now", not one row per probe), so
 * repeated probes against a still-red suite don't fork the ledger's identity for it.
 */
export async function openRedDebtEntry(
  input: OpenRedDebtEntryInput,
  database: Database = db,
): Promise<RedDebtRow> {
  const existing = await getOpenRedDebtEntry(input.projectId, input.suite, database);
  if (existing) return existing;

  const id = randomUUID();
  const openedAt = input.now ?? new Date().toISOString();
  await database.insert(redDebt).values({
    id,
    projectId: input.projectId,
    suite: input.suite,
    sinceCommit: input.sinceCommit,
    attributedIssueId: input.attributedIssueId ?? null,
    ownerIssueId: input.ownerIssueId ?? null,
    tag: input.tag,
    openedAt,
    resolvedAt: null,
  });
  const row = await firstRow(database.select().from(redDebt).where(eq(redDebt.id, id)));
  if (!row) throw new Error(`openRedDebtEntry: failed to read back inserted row ${id}`);
  return row;
}

/** Close an open entry (a probe reported the suite green again, breaking the red streak). */
export async function resolveRedDebtEntry(
  projectId: string,
  suite: string,
  database: Database = db,
  now?: string,
): Promise<void> {
  await database
    .update(redDebt)
    .set({ resolvedAt: now ?? new Date().toISOString() })
    .where(and(eq(redDebt.projectId, projectId), eq(redDebt.suite, suite), isNull(redDebt.resolvedAt)));
}

/** Attach the pay-down ticket the refiller filed for an entry. */
export async function setRedDebtOwnerIssue(
  entryId: string,
  ownerIssueId: string,
  database: Database = db,
): Promise<void> {
  await database.update(redDebt).set({ ownerIssueId }).where(eq(redDebt.id, entryId));
}

export interface ListRedDebtOptions {
  /** Include resolved entries too. Default: open-only. */
  includeResolved?: boolean;
}

/** All ledger entries for a project, newest-open-first. */
export async function listRedDebt(
  projectId: string,
  options: ListRedDebtOptions = {},
  database: Database = db,
): Promise<RedDebtRow[]> {
  const rows = await database
    .select()
    .from(redDebt)
    .where(
      options.includeResolved
        ? eq(redDebt.projectId, projectId)
        : and(eq(redDebt.projectId, projectId), isNull(redDebt.resolvedAt)),
    );
  return rows.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}
