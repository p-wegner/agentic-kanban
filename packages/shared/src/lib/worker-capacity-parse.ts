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
  return {
    freeRamGb, spareCores, thrashing,
    ...(totalRamGb !== undefined ? { totalRamGb } : {}),
    ...(freeDiskGb !== undefined ? { freeDiskGb } : {}),
    ...(totalCores !== undefined ? { totalCores } : {}),
  };
}
