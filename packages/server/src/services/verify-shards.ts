// Sharding a full-suite train gate across every free verify worker (#1578).
//
// Pure policy + the report merge; the transport stays `runOnPlannedWorker`. Each shard host runs the
// whole verify script (install + check:arch + typecheck once per host) with `KANBAN_RETRY_TEST_FILES`
// scoped to its slice of the suites, so the union of the shards is the full suite.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rankVerifyWorkers, type VerifyWorkerCandidate, type WorkerVerifyReport } from "./verify-placement.js";

/** Packages test-mine runs, `dir` → the label `KANBAN_RETRY_TEST_FILES` entries carry. */
const SHARD_PACKAGES: Record<string, string> = {
  "packages/shared": "shared",
  "packages/server": "server",
  "packages/mcp-server": "mcp-server",
  "packages/client": "client",
};

export interface ShardFile { entry: string; ms: number }

/** Idle (no builder session) ranked workers when at least two exist; otherwise every ranked worker. */
export function pickShardWorkers(allowlist: Set<string>, workers: VerifyWorkerCandidate[]): VerifyWorkerCandidate[] {
  const ranked = rankVerifyWorkers(allowlist, workers);
  const idle = ranked.filter((w) => (w.builderSessions ?? 0) === 0);
  return idle.length >= 2 ? idle : ranked;
}

/** Longest-processing-time-first split into `n` balanced shards (greedy onto the lightest). */
export function shardByDuration(files: ShardFile[], n: number): ShardFile[][] {
  const shards: { files: ShardFile[]; total: number }[] = Array.from({ length: Math.max(1, n) }, () => ({ files: [], total: 0 }));
  for (const f of [...files].sort((a, b) => b.ms - a.ms || a.entry.localeCompare(b.entry))) {
    const lightest = shards.reduce((m, s) => (s.total < m.total ? s : m));
    lightest.files.push(f);
    lightest.total += f.ms;
  }
  return shards.map((s) => s.files);
}

function walkTests(dir: string, base: string, out: string[]): void {
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walkTests(dir, rel, out);
    else if (/\.test\.tsx?$/.test(e.name) && !/\.(integration|e2e)\./.test(e.name)) out.push(rel);
  }
}

/**
 * Every suite of the tree as `label:file` entries with a duration: measured from the committed
 * `docs/tests/durations.json`, suites on disk it does not know get the median (never silently
 * dropped — a dropped suite would be a false green). Null when the tree has no durations report.
 */
export function listShardableSuites(workingDir: string): ShardFile[] | null {
  const path = join(workingDir, "docs/tests/durations.json");
  if (!existsSync(path)) return null;
  let measured: Map<string, number>;
  try {
    const json = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as { testResults?: { name: string; startTime: number; endTime: number }[] };
    measured = new Map((json.testResults ?? []).map((t) => [t.name.replace(/\\/g, "/"), Math.max(1, t.endTime - t.startTime)]));
  } catch {
    return null;
  }
  const sorted = [...measured.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 1;
  const out: ShardFile[] = [];
  for (const [dir, label] of Object.entries(SHARD_PACKAGES)) {
    if (!existsSync(join(workingDir, dir))) continue;
    const files: string[] = [];
    walkTests(join(workingDir, dir), "", files);
    for (const f of files) out.push({ entry: `${label}:${f}`, ms: measured.get(`${dir}/${f}`) ?? median });
  }
  return out.length > 0 ? out : null;
}

/** The union verdict of several shard reports: green only if every shard is; any refusal means nothing was fully verified. */
export function mergeShardReports(reports: { workerName: string; report: WorkerVerifyReport }[]): WorkerVerifyReport {
  const first = reports[0]!.report;
  const refused = reports.find((r) => r.report.refused);
  const failed = reports.filter((r) => !r.report.passed && !r.report.refused);
  const log = reports
    .map((r, i) => `===== shard ${i + 1}/${reports.length} on ${r.workerName}: ${r.report.refused ? `refused (${r.report.refused})` : r.report.passed ? "passed" : "FAILED"}` +
      `${r.report.failingSuites?.length ? ` — ${r.report.failingSuites.join(", ")}` : ""} =====\n${r.report.log ?? ""}`)
    .join("\n");
  return {
    ...first,
    passed: !refused && failed.length === 0,
    log,
    exitCode: failed.map((r) => r.report.exitCode).find((c) => c) ?? (failed.length ? 1 : first.exitCode),
    timedOut: reports.some((r) => r.report.timedOut === true),
    failingSuites: [...new Set(reports.flatMap((r) => r.report.failingSuites ?? []))],
    durationMs: Math.max(...reports.map((r) => r.report.durationMs ?? 0)),
    ...(refused ? { refused: refused.report.refused, reason: `shard on ${refused.workerName}: ${refused.report.reason ?? ""}` } : {}),
  };
}
