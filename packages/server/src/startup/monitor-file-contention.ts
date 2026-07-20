import {
  assessFileContention,
  computeHotFiles,
  resolveFileContentionMode,
  type ContentionIssueFiles,
  type ContentionVerdict,
  type FileContentionMode,
} from "@agentic-kanban/shared/lib/file-contention";
import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { parseTouchedFilePaths } from "../services/issue-ai.service.js";

/**
 * Auto-start gate for shared-registration-file contention (#119).
 *
 * The foundation-build dogfood showed that the dominant cost of parallel builds
 * was NOT ticket sizing but a shared wiring file: every feature registers itself
 * in `src/app.ts` / `app/main.py` / `Application.kt`, so the second of any two
 * concurrent builders hit a genuine adjacent-line conflict and burned an
 * agent-driven fix-and-merge cycle. Deferring that second start by one monitor
 * cycle costs nothing (the ticket launches as soon as the first lands) and
 * removes the whole fix-and-merge round-trip.
 *
 * This module builds a per-project snapshot ONCE per cycle (two queries) and
 * hands the auto-start loops a cheap synchronous `check(issueId)`.
 *
 * Fail-open everywhere: no cached prediction, no project row, a query error —
 * all mean "start it exactly as today". `analyzeTouchedFiles` costs an LLM call
 * on cache miss, so the gate reads only what is already cached and never
 * triggers analysis from inside the monitor cycle.
 */

const CONTENTION_PREF_PREFIX = "file_contention_";

/**
 * SQL predicate matching workspaces that hold an UNMERGED edit to the shared file.
 *
 * Deliberately NOT `AUTO_START_WIP_STATUSES` (`active`/`reviewing`/`fixing`) from
 * `monitor-auto-start.ts`. That set answers a different question — "is a live agent
 * consuming a WIP slot?" — and was narrowed in #690 precisely so dead/idle
 * workspaces stop holding capacity. Contention is not about a live agent: it is
 * about a branch that still carries the registration-file edit and has not landed
 * on the base yet. A workspace sitting in `ready_for_merge` (session-restore /
 * markReadyForMerge) or `idle` has FINISHED writing `src/app.ts` and is waiting to
 * merge — that is the PEAK contention window, and scoping to the WIP set made the
 * gate blind to exactly the #119 case it exists to prevent.
 *
 * `closed` is the correct cutoff and matches the auto-start loop's own
 * "issue already taken" check: closed+`mergedAt` means the edit is already in the
 * base (no conflict possible), closed without it means the branch was abandoned.
 * Everything else may still conflict. This errs toward deferring a start by one
 * cycle, which is cheap; under-deferring costs a full agent fix-and-merge cycle.
 */
export const inFlightWorkspacePredicate = sql`${workspaces.status} != 'closed'`;

export interface FileContentionGate {
  mode: FileContentionMode;
  /**
   * Verdict for a candidate issue. Returns `null` when the gate is off or the
   * candidate has no usable prediction.
   */
  check: (issueId: string) => ContentionVerdict | null;
  /**
   * Record an issue launched THIS cycle so later candidates in the same loop see
   * it as in-flight. Without this the gate would be useless in the common case:
   * the DB snapshot is taken before any launch, so two backlog tickets both
   * touching `src/app.ts` would both start in one cycle — the exact #119 pair.
   */
  noteStarted: (issueId: string) => void;
}

/** An always-allow gate — used when the feature is off or the snapshot failed. */
const OPEN_GATE: FileContentionGate = { mode: "off", check: () => null, noteStarted: () => {} };

/**
 * An always-allow gate. Injected by tests that exercise unrelated auto-start
 * logic so they don't have to model this module's queries.
 */
export function openFileContentionGate(): FileContentionGate {
  return OPEN_GATE;
}

/** Signature `runAutoStart` uses to obtain a gate — injectable for tests. */
export type BuildFileContentionGate = (
  prefMap: Map<string, string>,
  projectId: string,
) => Promise<FileContentionGate>;

export function resolveProjectContentionMode(prefMap: Map<string, string>, projectId: string): FileContentionMode {
  return resolveFileContentionMode(prefMap.get(`${CONTENTION_PREF_PREFIX}${projectId}`));
}

/**
 * Build the contention gate for one project.
 *
 * Hot files are derived from the project's OPEN issues that carry a cached
 * prediction (not just the in-flight ones) so the empirical
 * "predicted by >= N issues" signal has enough evidence — a registration file
 * the name heuristic doesn't know about still gets caught.
 *
 * Scoped to open issues on purpose. Counting Done/Cancelled issues too would make
 * the evidence set grow monotonically with project age: on a mature board (this
 * one is ~800 issues) almost any moderately-common file eventually accumulates 3
 * predictions, the hot set degenerates toward "every file", and the gate collapses
 * into "serialize on ANY shared predicted file" — throttling exactly the
 * parallelism it exists to protect. Open issues are also the semantically right
 * population: contention is a property of work that can still collide.
 */
export async function buildFileContentionGate(
  prefMap: Map<string, string>,
  projectId: string,
  database: Pick<typeof db, "select"> = db,
): Promise<FileContentionGate> {
  const mode = resolveProjectContentionMode(prefMap, projectId);
  if (mode === "off") return OPEN_GATE;

  try {
    const predicted = await database
      .select({ id: issues.id, touchedFilesJson: issues.touchedFilesJson })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(and(
        eq(issues.projectId, projectId),
        notInArray(projectStatuses.name, ["Done", "Cancelled"]),
      ));

    const filesByIssue = new Map<string, string[]>();
    const all: ContentionIssueFiles[] = [];
    for (const row of predicted) {
      const files = parseTouchedFilePaths(row.touchedFilesJson);
      if (files.length === 0) continue;
      filesByIssue.set(row.id, files);
      all.push({ issueId: row.id, files });
    }
    if (all.length === 0) return { ...OPEN_GATE, mode };

    const inFlightRows = await database
      .select({ issueId: workspaces.issueId })
      .from(workspaces)
      .where(inFlightWorkspacePredicate);

    const inFlight: ContentionIssueFiles[] = [];
    const seen = new Set<string>();
    for (const row of inFlightRows) {
      if (!row.issueId || seen.has(row.issueId)) continue;
      const files = filesByIssue.get(row.issueId);
      if (!files) continue; // other project, or no prediction — fail open
      seen.add(row.issueId);
      inFlight.push({ issueId: row.issueId, files });
    }

    const hotFiles = computeHotFiles(all);

    return {
      mode,
      check: (issueId: string) => {
        const files = filesByIssue.get(issueId);
        if (!files || inFlight.length === 0) return null;
        const verdict = assessFileContention({ issueId, files }, inFlight, hotFiles);
        return verdict.serialize ? verdict : null;
      },
      noteStarted: (issueId: string) => {
        if (seen.has(issueId)) return;
        const files = filesByIssue.get(issueId);
        if (!files) return;
        seen.add(issueId);
        inFlight.push({ issueId, files });
      },
    };
  } catch (err) {
    // Best-effort: a snapshot failure must never block auto-start.
    console.warn(`[monitor] File-contention gate unavailable for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
    return OPEN_GATE;
  }
}

/**
 * Apply the gate to one candidate. Returns true when the caller should SKIP this
 * issue for now. In `warn` mode it logs and returns false (start proceeds).
 */
export function shouldDeferForContention(
  gate: FileContentionGate,
  issueId: string,
  issueNumber: number | null,
): boolean {
  const verdict = gate.check(issueId);
  if (!verdict) return false;
  const label = issueNumber ?? issueId;
  const files = verdict.hotFiles.join(", ");
  if (gate.mode === "warn") {
    console.log(`[monitor] File contention (warn) for issue #${label}: shares ${files} with ${verdict.blockingIssueIds.length} in-flight issue(s) — starting anyway`);
    return false;
  }
  console.log(`[monitor] Deferring auto-start of issue #${label}: contends on ${files} with ${verdict.blockingIssueIds.length} in-flight issue(s) (#119 serialization)`);
  return true;
}
