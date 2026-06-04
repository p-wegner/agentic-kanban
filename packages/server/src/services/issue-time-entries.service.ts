import type { Database } from "../db/index.js";
import { getIssueProjectId } from "../repositories/issue.repository.js";
import {
  insertTimeEntry,
  getTimeEntries,
  getTotalMinutes,
  deleteTimeEntry,
  type TimeEntryRow,
} from "../repositories/issue-time-entries.repository.js";

export interface TimeEntry {
  id: string;
  issueId: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}

function toApiEntry(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    issueId: row.issueId,
    minutes: row.minutes,
    note: row.note,
    createdAt: row.createdAt,
  };
}

export function createIssueTimeEntriesService(deps: {
  database: Database;
}) {
  const { database } = deps;

  async function addEntry(input: {
    issueId: string;
    minutes: number;
    note?: string | null;
    now?: string;
  }): Promise<TimeEntry> {
    const row = await insertTimeEntry(input, database);
    return toApiEntry(row);
  }

  async function listEntries(issueId: string): Promise<TimeEntry[]> {
    const rows = await getTimeEntries(issueId, database);
    return rows.map(toApiEntry);
  }

  async function totalMinutes(issueId: string): Promise<number> {
    return getTotalMinutes(issueId, database);
  }

  async function removeEntry(entryId: string): Promise<void> {
    await deleteTimeEntry(entryId, database);
  }

  return { addEntry, listEntries, totalMinutes, removeEntry };
}

export type IssueTimeEntriesService = ReturnType<typeof createIssueTimeEntriesService>;
