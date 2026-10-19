// Sharding the full rc sweep across workers' verify slots (#1632).
//
// One full sweep on one worker took ~1050-1090 s while other eligible workers sat idle. This module is
// the pure half of spreading it: the shard PLAN (package first, `server` further split by vitest
// `--shard i/n`), the VERDICT MERGE (green only if every shard is green), the timing book the next
// plan balances on, and the `sweep 3/5 shards done` progress line. `runShardedSweep` is the scheduler;
// the transport (one shard on one worker) is injected, so every rule here is a table of cheap cases.
import type { VerifyWorkerCandidate } from "./verify-placement.js";

/** One independently runnable slice of the full sweep. */
export interface SweepShard {
  id: string;
  /** Package name (or `static` for typecheck/build). */
  pkg: string;
  /** 1-based vitest shard index and the total, for a split package; `1/1` otherwise. */
  index: number;
  total: number;
  command: string;
}

export interface SweepPackage {
  pkg: string;
  /** The pnpm `--filter` selector. */
  filter: string;
  /** Eligible for a further `--shard i/n` split (the long one). */
  splittable?: boolean;
}

/** This monorepo's packages, in the order `test:full` runs them. */
export const DEFAULT_SWEEP_PACKAGES: readonly SweepPackage[] = [
  { pkg: "shared", filter: "@agentic-kanban/shared" },
  { pkg: "server", filter: "agentic-kanban", splittable: true },
  { pkg: "mcp-server", filter: "@agentic-kanban/mcp-server" },
  { pkg: "client", filter: "@agentic-kanban/client" },
];

/** typecheck + build are part of the verify chain too; they run as one shard so no coverage is lost. */
export const STATIC_SHARD_COMMAND = "pnpm typecheck && pnpm build";

/** Recorded wall-clock per shard id, from earlier sweeps. */
export type ShardTimings = Record<string, number>;

/** Wall-clock one server shard should take; the server shard count is sized from the recorded server total. */
export const TARGET_SHARD_MS = 4 * 60 * 1000;
export const DEFAULT_SERVER_SHARDS = 4;
export const MAX_SERVER_SHARDS = 8;

const shardId = (pkg: string, index: number, total: number): string => (total > 1 ? `${pkg}:${index}/${total}` : pkg);

/** How many vitest shards the long package gets: sized from its recorded total time, default 4. */
export function serverShardCount(timings: ShardTimings, pkg = "server"): number {
  let totalMs = 0;
  let seen = false;
  for (const [id, ms] of Object.entries(timings)) {
    if (id === pkg || id.startsWith(`${pkg}:`)) {
      totalMs += ms;
      seen = true;
    }
  }
  if (!seen || totalMs <= 0) return DEFAULT_SERVER_SHARDS;
  return Math.min(MAX_SERVER_SHARDS, Math.max(1, Math.ceil(totalMs / TARGET_SHARD_MS)));
}

/**
 * The shard plan, longest first (so the scheduler's greedy pick is LPT-balanced on recorded timings;
 * a shard with no timing sorts as the longest known one, because an unmeasured shard is a risk).
 */
export function planSweepShards(opts: { packages?: readonly SweepPackage[]; timings?: ShardTimings; includeStatic?: boolean } = {}): SweepShard[] {
  const packages = opts.packages ?? DEFAULT_SWEEP_PACKAGES;
  const timings = opts.timings ?? {};
  const shards: SweepShard[] = [];
  for (const p of packages) {
    const total = p.splittable ? serverShardCount(timings, p.pkg) : 1;
    for (let index = 1; index <= total; index++) {
      const split = total > 1 ? ` --shard ${index}/${total}` : "";
      shards.push({ id: shardId(p.pkg, index, total), pkg: p.pkg, index, total, command: `pnpm --filter ${p.filter} exec vitest run${split}` });
    }
  }
  if (opts.includeStatic !== false) shards.push({ id: "static", pkg: "static", index: 1, total: 1, command: STATIC_SHARD_COMMAND });
  const longest = Math.max(0, ...Object.values(timings));
  const cost = (s: SweepShard): number => timings[s.id] ?? (longest || Number.MAX_SAFE_INTEGER);
  return shards.sort((a, b) => cost(b) - cost(a) || a.id.localeCompare(b.id));
}

/**
 * The coverage invariant: every package appears with shards 1..n of one n, each exactly once (so
 * vitest's `--shard` partition covers every test file exactly once), and every wanted package is present.
 */
export function checkShardCoverage(shards: readonly SweepShard[], wanted: readonly string[]): string[] {
  const problems: string[] = [];
  const byPkg = new Map<string, SweepShard[]>();
  for (const s of shards) byPkg.set(s.pkg, [...(byPkg.get(s.pkg) ?? []), s]);
  for (const pkg of wanted) if (!byPkg.has(pkg)) problems.push(`package ${pkg} has no shard`);
  for (const [pkg, list] of byPkg) {
    const totals = new Set(list.map((s) => s.total));
    if (totals.size !== 1) {
      problems.push(`package ${pkg} mixes shard totals ${[...totals].join(",")}`);
      continue;
    }
    const total = [...totals][0]!;
    const indices = list.map((s) => s.index).sort((a, b) => a - b);
    const expected = Array.from({ length: total }, (_, i) => i + 1);
    if (indices.join(",") !== expected.join(",")) problems.push(`package ${pkg} shards ${indices.join(",")} are not exactly 1..${total}`);
  }
  return problems;
}

/** What one shard came back as. `lost` = the worker dropped / was unreachable / refused: nothing was verified. */
export type ShardOutcome = "green" | "red" | "lost";

export interface ShardResult {
  shard: SweepShard;
  outcome: ShardOutcome;
  durationMs: number;
  workerName?: string;
  failedSuites?: string[];
  /** Runs spent on this shard (2 = it was retried once). */
  attempts: number;
  reason?: string;
}

export interface MergedSweepVerdict {
  /** `inconclusive` is a non-answer, never green. */
  outcome: "green" | "red" | "inconclusive";
  failedSuites: string[];
  redShards: string[];
  lostShards: string[];
  message: string;
}

/** One verdict: red if any shard is red (suites merged), else inconclusive if any shard is lost, else green. */
export function mergeShardVerdicts(results: readonly ShardResult[], expected: readonly SweepShard[] = results.map((r) => r.shard)): MergedSweepVerdict {
  const seen = new Set(results.filter((r) => r.outcome !== "lost").map((r) => r.shard.id));
  const failedSuites = [...new Set(results.flatMap((r) => (r.outcome === "red" ? (r.failedSuites ?? []) : [])))].sort();
  const redShards = results.filter((r) => r.outcome === "red").map((r) => r.shard.id);
  // A shard with no result at all counts as lost: absence must never read as green.
  const resultIds = new Set(results.map((r) => r.shard.id));
  const lostShards = [
    ...results.filter((r) => r.outcome === "lost").map((r) => r.shard.id),
    ...expected.filter((s) => !resultIds.has(s.id)).map((s) => s.id),
  ];
  const done = seen.size;
  const progress = `${done}/${expected.length} shards answered`;
  if (redShards.length > 0) {
    const lost = lostShards.length ? `; ${lostShards.length} shard(s) lost (${lostShards.join(", ")})` : "";
    return { outcome: "red", failedSuites, redShards, lostShards, message: `sweep RED: ${redShards.join(", ")} failed (${progress})${lost}` };
  }
  if (lostShards.length > 0) {
    return { outcome: "inconclusive", failedSuites, redShards, lostShards, message: `sweep INCONCLUSIVE: shard(s) ${lostShards.join(", ")} lost after a retry; the tree was NOT fully verified (${progress})` };
  }
  return { outcome: "green", failedSuites, redShards, lostShards, message: `sweep green: all ${expected.length} shards green` };
}

/** `sweep 3/5 shards done · 7m` — the watch view / gate-evidence line. */
export function formatSweepProgress(done: number, total: number, elapsedMs: number): string {
  const min = Math.floor(elapsedMs / 60000);
  const elapsed = min >= 1 ? `${min}m` : `${Math.max(0, Math.round(elapsedMs / 1000))}s`;
  return `sweep ${done}/${total} shards done · ${elapsed}`;
}

/** The persisted timing book: JSON of shard id → ms. Anything unparseable reads as empty (default plan). */
export function parseShardTimings(raw: string | null | undefined): ShardTimings {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: ShardTimings = {};
    for (const [k, ms] of Object.entries(v as Record<string, unknown>)) if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) out[k] = ms;
    return out;
  } catch {
    return {};
  }
}

/** Fold a finished sweep's GREEN/RED answered shards into the book (a lost shard measured nothing). The plan's shape wins: stale ids are dropped. */
export function recordShardTimings(prev: ShardTimings, results: readonly ShardResult[]): ShardTimings {
  const next: ShardTimings = {};
  const planIds = new Set(results.map((r) => r.shard.id));
  for (const [id, ms] of Object.entries(prev)) if (planIds.has(id)) next[id] = ms;
  for (const r of results) if (r.outcome !== "lost" && r.durationMs > 0) next[r.shard.id] = Math.round(r.durationMs);
  return next;
}

export interface ShardRunReport {
  outcome: ShardOutcome;
  durationMs: number;
  failedSuites?: string[];
  reason?: string;
}

export interface RunShardedSweepArgs {
  shards: readonly SweepShard[];
  /** Workers already filtered to eligible (trusted, calm, free slots); each offers `freeSlots` concurrent shards. */
  workers: readonly Pick<VerifyWorkerCandidate, "id" | "name" | "freeSlots">[];
  /** Run ONE shard on ONE worker. May throw: that is a lost shard. */
  runShard: (shard: SweepShard, worker: { id: string; name: string }) => Promise<ShardRunReport>;
  /** Called after every finished shard, for the progress line. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Hand shards (already longest-first) to free worker slots; a lost shard is retried ONCE on a different
 * worker when one exists (else the same one), then stays `lost`. Never throws.
 */
export async function runShardedSweep(args: RunShardedSweepArgs): Promise<ShardResult[]> {
  const slots = new Map<string, number>(args.workers.map((w) => [w.id, Math.max(1, w.freeSlots)]));
  const byId = new Map(args.workers.map((w) => [w.id, w]));
  const queue: Array<{ shard: SweepShard; attempts: number; avoid?: string; firstReason?: string }> = args.shards.map((shard) => ({ shard, attempts: 0 }));
  const results: ShardResult[] = [];
  let done = 0;
  if (args.workers.length === 0) {
    return args.shards.map((shard) => ({ shard, outcome: "lost" as const, durationMs: 0, attempts: 0, reason: "no eligible worker" }));
  }

  await new Promise<void>((resolve) => {
    let inFlight = 0;
    const pump = (): void => {
      while (queue.length > 0) {
        const job = queue[0]!;
        // Prefer a worker with a free slot other than the one that just lost this shard.
        const free = [...slots.entries()].filter(([, n]) => n > 0).map(([id]) => id);
        const pick = free.find((id) => id !== job.avoid) ?? (free.length > 0 && (inFlight === 0 || job.avoid === undefined) ? free[0] : undefined);
        if (!pick) break;
        queue.shift();
        slots.set(pick, slots.get(pick)! - 1);
        inFlight++;
        const worker = byId.get(pick)!;
        const startedAt = Date.now();
        void args
          .runShard(job.shard, { id: worker.id, name: worker.name })
          .catch((e: unknown): ShardRunReport => ({ outcome: "lost", durationMs: Date.now() - startedAt, reason: e instanceof Error ? e.message : String(e) }))
          .then((rep) => {
            slots.set(pick, slots.get(pick)! + 1);
            inFlight--;
            const attempts = job.attempts + 1;
            if (rep.outcome === "lost" && attempts < 2) {
              queue.unshift({ shard: job.shard, attempts, avoid: pick, firstReason: rep.reason });
            } else {
              results.push({ shard: job.shard, outcome: rep.outcome, durationMs: rep.durationMs, workerName: worker.name, failedSuites: rep.failedSuites, attempts, reason: rep.reason ?? job.firstReason });
              done++;
              try { args.onProgress?.(done, args.shards.length); } catch { /* progress is best-effort */ }
            }
            pump();
          });
      }
      if (inFlight === 0) resolve();
    };
    pump();
  });
  // Anything still queued (cannot happen unless slots vanished) is lost, never green.
  for (const j of queue) results.push({ shard: j.shard, outcome: "lost", durationMs: 0, attempts: j.attempts, reason: "never scheduled" });
  return results;
}
