import { unlink } from "node:fs/promises";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Classification + repair for the recorded pnpm-store I/O-fault signature (#1125).
 *
 * All nine recorded setup failures were one error: `ERR_PNPM_UNKNOWN  UNKNOWN: unknown
 * error, stat '<pnpm-store file>'`. `UNKNOWN`/errno `-4094` is libuv's fallback for a Win32
 * error it has no mapping for — reproduced against a file left behind by one of these
 * failures, the real Win32 error is "the file or directory is corrupted and unreadable"
 * (`ERROR_FILE_CORRUPT`). A plain retry does not help: the store entry stays unreadable
 * until something rewrites it, so a blind repeat of the same install fails identically.
 *
 * The store is content-addressed, so deleting the one corrupt entry is safe by
 * construction — pnpm re-fetches it on the next install. That is the ONLY reason a retry
 * here has a chance of succeeding, which is why classification (this file) always runs
 * before a retry, never after.
 */

const IO_FAULT_SIGNATURE = /\bERR_PNPM_UNKNOWN\b|\berrno[:=]?\s*-?4094\b|\bUNKNOWN:\s*unknown error\b/i;
/** pnpm's own error names the syscall and the path: `stat 'C:\...\files\42\a81d86...'`. */
const OFFENDING_PATH_PATTERN = /\b(?:stat|lstat|unlink|open|read|rename)\s+'([^']+)'/i;
/** Only delete a path the store itself owns — the store is content-addressed, nothing else is. */
const PNPM_STORE_SEGMENT = /[\\/]\.?pnpm-store[\\/]/i;
/**
 * `describeSetupFailure` writes a `[io-fault: ...]` banner into the persisted `stderrTail`,
 * and that same persisted tail is what the NEXT sweep passes back into `classifySetupFailure`
 * to judge the prior run. The banner's own label text contains the literal signature
 * (`ERR_PNPM_UNKNOWN`), so without stripping it first, a workspace classified once stays
 * classified as an io-fault forever — every later cycle matches the banner it wrote last
 * time, no matter what the real, current failure actually is. Strip any banner this module
 * itself produced before testing the signature.
 */
const IO_FAULT_BANNER_PATTERN = /\[io-fault:[^\]]*\]/g;

export type SetupFailureClassification =
  | { kind: "io-fault"; offendingPath: string | null; label: string }
  | { kind: "unclassified" };

/**
 * Pure decision function: inspects RECORDED output, decides nothing about the filesystem.
 * Ticket ask 1 — "record the classification rather than a bare exit code, so an agent
 * reading the card does not go looking for a pnpm bug."
 */
export function classifySetupFailure(output: {
  stdout?: string | null;
  stderr?: string | null;
}): SetupFailureClassification {
  const combinedRaw = [output.stderr, output.stdout].filter((s): s is string => Boolean(s)).join("\n");
  const combined = combinedRaw.replace(IO_FAULT_BANNER_PATTERN, "");
  if (!IO_FAULT_SIGNATURE.test(combined)) return { kind: "unclassified" };
  const match = combined.match(OFFENDING_PATH_PATTERN);
  const offendingPath = match && PNPM_STORE_SEGMENT.test(match[1]) ? match[1] : null;
  return {
    kind: "io-fault",
    offendingPath,
    label: "I/O fault (ERR_PNPM_UNKNOWN/errno -4094) — a corrupted pnpm-store file, not a dependency or lockfile problem",
  };
}

export interface RepairResult {
  attempted: boolean;
  repaired: boolean;
  reason: string;
}

/**
 * Delete the one offending pnpm-store entry so the next install re-fetches it. Best-effort
 * and honest, per the ticket's note that the host disk is separately logging bad blocks: a
 * repair that itself fails (still corrupted/unreadable) must say so, never swallow it.
 */
export async function repairIoFault(classification: SetupFailureClassification): Promise<RepairResult> {
  if (classification.kind !== "io-fault") {
    return { attempted: false, repaired: false, reason: "not classified as an I/O fault" };
  }
  if (!classification.offendingPath) {
    return { attempted: false, repaired: false, reason: "no offending pnpm-store path found in the recorded output" };
  }
  try {
    await unlink(classification.offendingPath);
    return { attempted: true, repaired: true, reason: `deleted the corrupted store entry (${classification.offendingPath})` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // Already gone — another sweep, or the operator, beat us to it. That is success, not
      // a failure to report.
      return { attempted: true, repaired: true, reason: "store entry was already gone" };
    }
    return {
      attempted: true,
      repaired: false,
      reason: `could not remove the store entry (${classification.offendingPath}): ${errorMessage(err)}`,
    };
  }
}

/**
 * One line to prefix onto a restamped `stderrTail` so the card names the classification and
 * the repair outcome instead of a bare exit code.
 */
export function describeSetupFailure(classification: SetupFailureClassification, repair?: RepairResult): string {
  if (classification.kind !== "io-fault") return "";
  const repairPart = repair
    ? repair.attempted
      ? repair.repaired
        ? `repaired: ${repair.reason}`
        : `repair FAILED: ${repair.reason}`
      : repair.reason
    : "not yet repaired";
  return `[io-fault: ${classification.label}; ${repairPart}]`;
}
