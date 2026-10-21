import type { WorkerCapacityInfo } from "./worker-protocol.js";

/** #1658: one `os.cpus()` snapshot reduced to summed busy/total ticks. */
export interface CpuTicks { busy: number; total: number }

export function sumCpuTicks(cpus: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTicks {
  let busy = 0, total = 0;
  for (const c of cpus) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

/** CPU % between two tick snapshots (works on Windows, unlike loadavg). Undefined when no time elapsed. */
export function cpuPctBetween(prev: CpuTicks, next: CpuTicks): number | undefined {
  const dTotal = next.total - prev.total;
  if (dTotal <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round(((next.busy - prev.busy) / dTotal) * 1000) / 10));
}

/** Workers whose capacity reports the same host fingerprint share one physical CPU budget. */
export function sharesHost(a: Pick<WorkerCapacityInfo, "hostFingerprint"> | undefined, b: Pick<WorkerCapacityInfo, "hostFingerprint"> | undefined): boolean {
  return !!a?.hostFingerprint && a.hostFingerprint === b?.hostFingerprint;
}

export const LOAD_SUSPECT_CPU_PCT = 85;

/** A red verdict made only of timeouts on a worker above the CPU threshold is "load-suspect" (#1658). */
export function isLoadSuspect(failures: ReadonlyArray<{ timedOut: boolean }>, cpuPct: number | undefined, threshold = LOAD_SUSPECT_CPU_PCT): boolean {
  return failures.length > 0 && failures.every((f) => f.timedOut) && cpuPct !== undefined && cpuPct > threshold;
}

/** Slow when elapsed exceeds `factor` x baseline; unknown baseline is never slow. */
export function isRunningSlow(elapsedMs: number, baselineMs: number | undefined, factor = 1.5): boolean {
  return baselineMs !== undefined && baselineMs > 0 && elapsedMs > baselineMs * factor;
}
