// Capabilities-blob parser split out of worker-protocol.ts (#1605); re-exported there.
import { parseWorkerCapacityInfo } from "./worker-capacity-parse.js";
import { parseWorkerVerifyCapability } from "./worker-verify-protocol.js";
import { parseWorkerPackageManagers } from "./worker-prerequisites.js";
import { parseWorkerDoctorSummary } from "./worker-doctor-summary.js";
import { parseWorkerProfileAttestations, parseWorkerUnattestedProfiles } from "./worker-profile-attestation.js";
import { parseWorkerToolchains } from "./worker-toolchains.js";
import { parseWorkerToolchainInstallInfo } from "./worker-toolchain-install.js";
import type { WorkerCapabilities } from "./worker-protocol.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Shape-check a capabilities blob off the wire. Unknown/ill-typed fields are dropped. */
export function parseWorkerCapabilities(raw: unknown): WorkerCapabilities | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
  const labels = strings(rec.labels);
  const providers = strings(rec.providers);
  const maxConcurrency =
    typeof rec.maxConcurrency === "number" && Number.isInteger(rec.maxConcurrency) && rec.maxConcurrency > 0
      ? rec.maxConcurrency
      : undefined;
  const capacity = parseWorkerCapacityInfo(rec.capacity);
  const profiles = parseWorkerProfileAttestations(rec.profiles); const unattestedProfiles = parseWorkerUnattestedProfiles(rec.unattestedProfiles);
  const packageManagers = parseWorkerPackageManagers(rec.packageManagers);
  const toolchains = parseWorkerToolchains(rec.toolchains);
  const toolchainInstall = parseWorkerToolchainInstallInfo(rec.toolchainInstall);
  const providerNotice = typeof rec.providerNotice === "string" ? rec.providerNotice.trim().slice(0, 400) || undefined : undefined;
  const doctor = parseWorkerDoctorSummary(rec.doctor);
  const harnessMode = typeof rec.harnessMode === "string" && rec.harnessMode.trim() ? rec.harnessMode.trim().slice(0, 40) : undefined;
  const verify = parseWorkerVerifyCapability(rec.verify);
  if (
    labels === undefined &&
    providers === undefined &&
    maxConcurrency === undefined &&
    capacity === undefined && profiles === undefined && unattestedProfiles === undefined && packageManagers === undefined && toolchains === undefined && toolchainInstall === undefined && providerNotice === undefined &&
    doctor === undefined && verify === undefined && harnessMode === undefined
  ) {
    return undefined;
  }
  return {
    ...(toolchains ? { toolchains } : {}),
    ...(toolchainInstall ? { toolchainInstall } : {}),
    ...(labels ? { labels } : {}),
    ...(providers ? { providers } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(capacity ? { capacity } : {}),
    ...(profiles ? { profiles } : {}), ...(unattestedProfiles ? { unattestedProfiles } : {}),
    ...(packageManagers ? { packageManagers } : {}),
    ...(providerNotice ? { providerNotice } : {}),
    ...(doctor ? { doctor } : {}),
    ...(verify ? { verify } : {}),
    ...(harnessMode ? { harnessMode } : {}),
  };
}
