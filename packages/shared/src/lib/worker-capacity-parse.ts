import type { WorkerCapacityInfo } from "./worker-protocol.js";

/** Shape-check a capacity blob off the wire (#910, #1451). Anything malformed reads as absent/unknown. */
export function parseWorkerCapacityInfo(raw: unknown): WorkerCapacityInfo | undefined {
  const rec = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!rec) return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const gb = (v: unknown): number | undefined => { const n = num(v); return n !== undefined && n >= 0 ? n : undefined; };
  const freeRamGb = num(rec.freeRamGb);
  const spareCores = num(rec.spareCores);
  const thrashing = typeof rec.thrashing === "string" ? rec.thrashing : undefined;
  if (freeRamGb === undefined || spareCores === undefined || thrashing === undefined) return undefined;
  const totalRamGb = gb(rec.totalRamGb);
  const freeDiskGb = gb(rec.freeDiskGb);
  const totalCores = num(rec.totalCores) !== undefined && (num(rec.totalCores) as number) > 0 ? Math.floor(rec.totalCores as number) : undefined;
  const pct = (v: unknown): number | undefined => { const n = num(v); return n !== undefined && n >= 0 && n <= 100 ? n : undefined; };
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
  const cpuPct = pct(rec.cpuPct);
  const avg = typeof rec.cpuAvgPct === "object" && rec.cpuAvgPct !== null ? (rec.cpuAvgPct as Record<string, unknown>) : null;
  const cpuAvgPct = avg && pct(avg.m1) !== undefined && pct(avg.m5) !== undefined && pct(avg.m15) !== undefined
    ? { m1: pct(avg.m1) as number, m5: pct(avg.m5) as number, m15: pct(avg.m15) as number } : undefined;
  const swapUsedGb = gb(rec.swapUsedGb);
  const foreignHeavyProcs = gb(rec.foreignHeavyProcs);
  const jc = typeof rec.jobCounts === "object" && rec.jobCounts !== null && !Array.isArray(rec.jobCounts) ? (rec.jobCounts as Record<string, unknown>) : null;
  const jobCounts: Record<string, number> = {};
  if (jc) for (const [k, v] of Object.entries(jc)) { const n = gb(v); if (n !== undefined) jobCounts[k] = Math.floor(n); }
  const hostname = str(rec.hostname);
  const hostFingerprint = str(rec.hostFingerprint);
  return {
    ...(cpuPct !== undefined ? { cpuPct } : {}),
    ...(cpuAvgPct ? { cpuAvgPct } : {}),
    ...(swapUsedGb !== undefined ? { swapUsedGb } : {}),
    ...(jc ? { jobCounts } : {}),
    ...(foreignHeavyProcs !== undefined ? { foreignHeavyProcs: Math.floor(foreignHeavyProcs) } : {}),
    ...(hostname ? { hostname } : {}),
    ...(hostFingerprint ? { hostFingerprint } : {}),
    freeRamGb, spareCores, thrashing,
    ...(totalRamGb !== undefined ? { totalRamGb } : {}),
    ...(freeDiskGb !== undefined ? { freeDiskGb } : {}),
    ...(totalCores !== undefined ? { totalCores } : {}),
  };
}
