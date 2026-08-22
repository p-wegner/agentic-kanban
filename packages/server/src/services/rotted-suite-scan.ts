/**
 * Alarm on a test suite that has been red across CONSECUTIVE base-health probes (#681 half B).
 *
 * Half A asked "has this probe ever been green?" — a question about the probe. This is the
 * other half of the same ticket, and it is a question about the TREE: measured breakage age at
 * repair (`7e4dad1f1b`) was ~26 days for `console-tag-ratchet`, up to 60 h for
 * `codex-skills-parity`, and 58 minutes for `container-reap-terminal-paths` — broken by a
 * commit whose own author did not run the always-run set. The #614 time-spelling ratchet landed
 * already red, was fixed, and went red again for 47.9 h across 144 commits. Every one of those
 * commits' messages claimed green.
 *
 * Nothing reported any of it, because the only durable record was one boolean per probe. A run
 * that is red for the same reason every night and a run that is red for a NEW reason look
 * identical from the outside; the distinguishing fact is which suite, which vitest already
 * prints and which `failed_suites` now keeps.
 *
 * **Scope: every suite the project's verify script actually RAN, not only `@gate:always-run`
 * ones.** The marker's job is to tell a SCOPED test run what it must not skip; gating the alarm
 * on it would only narrow the alarm, and would do so by re-deriving the marker set from the repo
 * tree at runtime — a second copy of the scan that `scripts/test-mine.mjs` owns, and the root
 * CLAUDE.md is explicit that every copy of such a walker is a place the scan can diverge from
 * what it claims to cover. Every one of the measured cases above is a guard suite and is caught
 * either way.
 *
 * **What this alarm CANNOT see (#717).** An earlier version of this comment said the probe "runs
 * the whole verify script, so every suite in it is equally observed". That was false, and it was
 * the stated justification for the scope decision above — so the decision stands but the reason
 * has been corrected. `deriveVerifyCommand` prefers `quickTestCommand` on node
 * (`shared/lib/verify-command.ts`), i.e. `pnpm test:mine`, which carries a deliberate exclusion
 * list (`scripts/test-mine.mjs`). A live probe's own output shows it:
 * `[test:mine] mcp-server: node vitest run --exclude ** /mcp-tools.test.ts`. An EXCLUDED suite is
 * never named by any probe, so it can rot indefinitely and this alarm is structurally blind to
 * it — the same class of blindness #679 was filed to fix. Widening the probe to the full test
 * command would close that, at the cost of the flake-under-load reason `verify-command.ts` gives
 * for preferring the quick command; that trade is not made here.
 */
import type { RottedSuiteWarning } from "@agentic-kanban/shared/types";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getAllProjects } from "../repositories/project.repository.js";
import { listSuiteVerdicts } from "../repositories/base-branch-health.repository.js";

export type { RottedSuiteWarning };

/**
 * Consecutive red probes before a suite is called rotted, i.e. the ticket's "more than one
 * cycle" read literally.
 *
 * Two is deliberately the smallest number that means anything: one red probe is a suite that
 * broke, which the run itself already reports and which the author is usually mid-fixing. Two
 * consecutive means it survived a probe interval unrepaired, which is the property none of the
 * measured cases had anyone notice. Raising it would trade the alarm's whole purpose (26 days
 * of silence) for a quieter first day.
 */
export const ROTTED_SUITE_MIN_CONSECUTIVE = 2;

/** How many probes back to look. Bounds the query; a streak longer than this reports as this. */
export const ROTTED_SUITE_WINDOW = 30;

export interface SuiteVerdict {
  createdAt: string;
  /** `null` = this probe produced no per-suite verdict (timeout, unverified, pre-column row). */
  failedSuites: string[] | null;
}

export interface RottedSuite {
  suite: string;
  /** Consecutive verdict-bearing probes, newest first, in which this suite was red. */
  consecutiveRedProbes: number;
  /** When the streak's OLDEST red probe ran — how long it has been rotting. */
  redSinceAt: string;
  /** When the streak's newest red probe ran. */
  lastRedAt: string;
}

/**
 * The decision, pure and synchronous (a **decision function** per the server CLAUDE.md): given
 * a project's probe verdicts newest-first, which suites are red across a run of consecutive
 * verdict-bearing probes.
 *
 * Probes with a `null` list are SKIPPED rather than treated as a pass — a timeout learned
 * nothing about any suite, and letting it break a streak would silence the alarm exactly when
 * the probe is unhealthy, which is when it is least able to speak for the tree. They also do
 * not extend a streak, so a project whose probes all time out reports nothing here (half A's
 * degenerate-distribution alarm is what covers that case).
 */
export function findRottedSuites(
  verdicts: SuiteVerdict[],
  minConsecutive: number = ROTTED_SUITE_MIN_CONSECUTIVE,
): RottedSuite[] {
  const conclusive = verdicts.filter((v): v is SuiteVerdict & { failedSuites: string[] } => v.failedSuites !== null);
  if (conclusive.length < minConsecutive) return [];

  // Every suite named in the NEWEST verdict-bearing probe is a streak candidate. A suite that
  // is green now cannot be rotting now, however long it was red before — reporting it would
  // make the list a history rather than a to-do.
  const rotted: RottedSuite[] = [];
  for (const suite of conclusive[0].failedSuites) {
    let streak = 0;
    for (const verdict of conclusive) {
      if (!verdict.failedSuites.includes(suite)) break;
      streak += 1;
    }
    if (streak < minConsecutive) continue;
    rotted.push({
      suite,
      consecutiveRedProbes: streak,
      redSinceAt: conclusive[streak - 1].createdAt,
      lastRedAt: conclusive[0].createdAt,
    });
  }
  // Longest-rotting first: the ordering a reader wants, and stable for a test.
  return rotted.sort((a, b) => b.consecutiveRedProbes - a.consecutiveRedProbes || a.suite.localeCompare(b.suite));
}

/** How long the streak has been running, in whole hours, for the message. */
function hoursBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 3_600_000));
}

/**
 * One warning per project whose base-health probes name at least one persistently-red suite.
 *
 * Per project rather than per suite: a tree that is rotting usually rots in several suites at
 * once (the #549 case took `container-reap-terminal-paths` down alongside others), and N
 * warnings that all say "run the always-run set" is noise that trains a reader to skip them.
 */
export async function scanRottedSuites(
  database: Database = db,
  nowMs: number = Date.now(),
): Promise<RottedSuiteWarning[]> {
  const projects = await getAllProjects(database);
  const detectedAt = new Date(nowMs).toISOString();
  const warnings: RottedSuiteWarning[] = [];

  for (const project of projects) {
    const verdicts = await listSuiteVerdicts(project.id, ROTTED_SUITE_WINDOW, database).catch(() => null);
    if (!verdicts) continue;
    const rotted = findRottedSuites(verdicts);
    if (rotted.length === 0) continue;

    const worst = rotted[0];
    const ageHours = hoursBetween(worst.redSinceAt, worst.lastRedAt);
    const names = rotted.slice(0, 5).map((r) => `${r.suite} (${r.consecutiveRedProbes} probes)`);
    const more = rotted.length > names.length ? ` …and ${rotted.length - names.length} more` : "";

    warnings.push({
      type: "rotted_suite",
      projectId: project.id,
      projectName: project.name,
      detectedAt,
      suiteCount: rotted.length,
      longestStreakProbes: worst.consecutiveRedProbes,
      longestStreakHours: ageHours,
      suites: rotted.map((r) => ({
        suite: r.suite,
        consecutiveRedProbes: r.consecutiveRedProbes,
        redSinceAt: r.redSinceAt,
        lastRedAt: r.lastRedAt,
      })),
      message:
        `${rotted.length} test suite(s) in "${project.name}" have been red across every base-health probe ` +
        `for ${worst.consecutiveRedProbes} probes running` +
        (ageHours > 0 ? ` (~${ageHours}h)` : "") +
        `: ${names.join(", ")}${more}. ` +
        `A suite still red on the NEXT probe was not being fixed between them — this is the state that let ` +
        `console-tag-ratchet sit broken ~26 days while every commit message claimed green. Fix or delete it; ` +
        `a permanently-red guard is a guard nobody reads.`,
    });
  }
  return warnings;
}
