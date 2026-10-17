/**
 * Dependency-advisory heal tickets (#1564).
 *
 * `scripts/security-scan.mjs` (critical/high advisories in the production graph) used to run only in
 * the GitHub `security-scan` workflow, so a CRITICAL advisory sat red for 10 days (#1554) while the
 * board merged and promoted normally. The base sweep now runs it too, lockfile-only, seconds:
 * `security-scan.mjs --advisories-only` exits 0 clean / 1 breach / 2 did not run.
 *
 * A breach files ONE `heal` ticket per ADVISORY (`dep-advisory:<projectId>:<ghsa>`), naming package,
 * advisory and fixed version; a repeat sweep refreshes it, an advisory that is gone closes it. A
 * new advisory against an unchanged lockfile is therefore caught by the next sweep, not the next push.
 * A scan that did not run neither files nor closes. Never throws: this hangs off a health probe.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { HEAL_TICKET_TAG } from "../lib/heal-ticket-key.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getDoneStatusIds, updateIssueById } from "../repositories/issue-service.repository.js";
import { getMinIssueSortOrder, listIssuesByExternalKeyPrefix } from "../repositories/issue/heal-ticket.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import { applyIssueTag } from "./repo-tags.service.js";

export const ADVISORY_KEY_PREFIX = "dep-advisory:";
const HEAL_TAG_COLOR = "#dc2626";
const SCAN_SCRIPT_RELPATH = join("scripts", "security-scan.mjs");

export interface AdvisoryBreach {
  ghsa: string;
  severity: string;
  module: string;
  vulnerable?: string;
  patched?: string;
  title?: string;
  url?: string;
}

export type AdvisoryScanResult = { ran: true; breaches: AdvisoryBreach[] } | { ran: false; reason: string };

export function advisoryExternalKey(projectId: string, ghsa: string): string {
  return `${ADVISORY_KEY_PREFIX}${projectId}:${ghsa}`;
}

export function advisoryTicketTitle(b: AdvisoryBreach): string {
  return `heal: ${b.severity} advisory ${b.ghsa} in ${b.module}${b.patched ? ` (fixed in ${b.patched})` : ""}`;
}

export function advisoryTicketBody(b: AdvisoryBreach): string {
  return [
    `The base sweep's dependency scan (\`scripts/security-scan.mjs --advisories-only\`) found a ${b.severity.toUpperCase()} advisory in the PRODUCTION dependency graph.`,
    ``,
    `- Package: \`${b.module}\``,
    `- Vulnerable versions: \`${b.vulnerable ?? "?"}\``,
    `- Fixed in: \`${b.patched ?? "no fix published"}\``,
    `- Advisory: ${b.ghsa}${b.url ? ` — ${b.url}` : ""}`,
    b.title ? `- Title: ${b.title}` : ``,
    ``,
    `Raise the dependency (or the override floor in \`pnpm-workspace.yaml\`) past the fixed version. \`pnpm promote\` refuses`,
    `while this stands unless \`--accept-advisories\` is passed. The sweep refreshes this ticket while the advisory is`,
    `reported and closes it once it is gone.`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
}

/** Default scan: run the repo's own script in `repoPath`. Absent script = project does not use it. */
export function runAdvisoryScan(repoPath: string): Promise<AdvisoryScanResult> {
  const script = join(repoPath, SCAN_SCRIPT_RELPATH);
  if (!existsSync(script)) return Promise.resolve({ ran: false, reason: "no scripts/security-scan.mjs in the project" });
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, "--advisories-only"],
      { cwd: repoPath, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        if (code !== 0 && code !== 1) return resolve({ ran: false, reason: `scan exited ${code}` });
        try {
          const parsed = JSON.parse(stdout) as { breaches?: AdvisoryBreach[] };
          resolve({ ran: true, breaches: parsed.breaches ?? [] });
        } catch {
          resolve({ ran: false, reason: "scan output was not parseable JSON" });
        }
      },
    );
  });
}

export interface AdvisoryReconcileResult {
  created: number[];
  refreshed: number[];
  closed: number[];
  skipped?: string;
}

export async function reconcileDependencyAdvisoryTickets(
  input: {
    projectId: string;
    repoPath: string;
    runScan?: (repoPath: string) => Promise<AdvisoryScanResult>;
    createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
    now?: string;
  },
  database: Database = db,
): Promise<AdvisoryReconcileResult> {
  const result: AdvisoryReconcileResult = { created: [], refreshed: [], closed: [] };
  const { projectId } = input;
  try {
    const scan = await (input.runScan ?? runAdvisoryScan)(input.repoPath);
    if (!scan.ran) return { ...result, skipped: scan.reason };

    const now = input.now ?? new Date().toISOString();
    const prefix = `${ADVISORY_KEY_PREFIX}${projectId}:`;
    const rows = await listIssuesByExternalKeyPrefix(projectId, prefix, database);
    const open = rows.filter((r) => r.externalKey?.startsWith(prefix) && !LEGACY_TERMINAL_STATUS_NAMES.has(r.statusName ?? ""));
    const createIssue = input.createIssue ?? createIssueService({ database }).createIssue;

    for (const b of scan.breaches) {
      const key = advisoryExternalKey(projectId, b.ghsa);
      const existing = open.find((r) => r.externalKey === key);
      console.log(
        `[dependency-advisory] project ${projectId}: ${b.severity} ${b.module} ${b.ghsa} (fixed in ${b.patched ?? "n/a"}) — `
          + `${existing ? `refreshing ticket #${existing.issueNumber}` : "filing heal ticket"}`,
      );
      if (existing) {
        await updateIssueById(existing.id, { title: advisoryTicketTitle(b), description: advisoryTicketBody(b), priority: "critical", updatedAt: now }, database);
        result.refreshed.push(existing.issueNumber ?? 0);
        continue;
      }
      const minSort = await getMinIssueSortOrder(projectId, database);
      const issue = await createIssue({
        projectId,
        title: advisoryTicketTitle(b),
        description: advisoryTicketBody(b),
        issueType: "task",
        priority: "critical",
        sortOrder: (minSort ?? 0) - 1,
        externalKey: key,
      });
      await applyIssueTag(issue.id, HEAL_TICKET_TAG, HEAL_TAG_COLOR, database).catch(() => {});
      result.created.push(issue.issueNumber ?? 0);
    }

    const stale = open.filter((r) => !scan.breaches.some((b) => advisoryExternalKey(projectId, b.ghsa) === r.externalKey));
    if (stale.length > 0) {
      const doneStatusIds = await getDoneStatusIds(projectId, database);
      for (const t of stale) {
        await insertIssueComment(
          { issueId: t.id, kind: "note", author: "system", body: "The base sweep's dependency scan no longer reports this advisory in the production graph.", createdAt: now },
          database,
        ).catch(() => {});
        if (doneStatusIds.length === 0) continue;
        await updateIssueById(t.id, { statusId: doneStatusIds[0], statusChangedAt: now, updatedAt: now }, database);
        result.closed.push(t.issueNumber ?? 0);
      }
    }
    return result;
  } catch (err) {
    console.warn(`[dependency-advisory] reconcile failed for project ${projectId} (non-fatal):`, err instanceof Error ? err.message : String(err));
    return { ...result, skipped: `reconcile failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
