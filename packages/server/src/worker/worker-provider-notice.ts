// #1372 — "this worker advertises no usable provider". A worker whose declared providers all failed
// attestation registers fine and reads `online`, yet receives no work; this is the line (and the
// board-row reason) that says so. Db-free: ships in the standalone worker binary.
import { attestProviderAuth, type DoctorCheck } from "../cli/commands/worker-doctor.js";
import type { WorkerHarness } from "./worker-harness.js";

/** Short human reason for the first check that kept a provider out of the advertised set. */
export function shortProviderReason(checks: DoctorCheck[]): string {
  const failed = checks.find((c) => c.status !== "pass" && c.status !== "skip");
  if (!failed) return "could not be confirmed";
  return /CLI installed$/.test(failed.name) ? "not installed" : "not logged in";
}

/** `claude: not installed, codex: not logged in`. */
export function describeExcluded(excluded: Array<{ provider: string; reason: string }>): string {
  return excluded.map((e) => `${e.provider}: ${e.reason}`).join(", ");
}

/**
 * The warning for a worker that declared providers but advertises none; undefined when at least one
 * provider attested (or none were declared, which is the operator's own choice).
 */
export function noUsableProviderNotice(
  declared: string[] | undefined,
  advertised: string[] | undefined,
  excluded: Array<{ provider: string; reason: string }>,
): string | undefined {
  if (!declared || declared.length === 0) return undefined;
  if (advertised && advertised.length > 0) return undefined;
  const why = excluded.length > 0 ? describeExcluded(excluded) : declared.map((p) => `${p}: unconfirmed`).join(", ");
  return (
    `this worker advertises no usable provider (${why}) - it will receive no work; ` +
    "run agentic-kanban-worker setup (agentic-kanban-worker doctor shows the detail)"
  );
}

/**
 * Narrow a worker's declared `--providers` down to the ones this machine can actually PROVE
 * it is authenticated for (#895). Before this, `providers` was advertised exactly like
 * `--labels` - pure operator declaration, never checked - so a login that lapsed (as in the
 * live #895 repro) kept being advertised as eligible with a 100% dispatch-failure rate and no
 * signal anywhere. `log` receives one line per EXCLUDED provider, naming the reason
 * `checkProvider` found; a provider that attests is not logged here (see call sites for the
 * change-only summary line used on re-checks). `excluded` (#1372) collects each one with a short reason.
 */
export async function attestProviders(
  requested: string[],
  log: (line: string) => void,
  harness?: WorkerHarness,
  excluded?: Array<{ provider: string; reason: string }>,
): Promise<string[]> {
  const attested: string[] = [];
  for (const provider of requested) {
    const result = await attestProviderAuth(provider, undefined, undefined, harness);
    if (result.attested) {
      attested.push(provider);
      continue;
    }
    excluded?.push({ provider, reason: shortProviderReason(result.checks) });
    const reason = result.checks.find((c) => c.status !== "pass")?.detail ?? "could not be confirmed";
    log(
      `[worker] NOT advertising provider '${provider}': ${reason}. This worker will not be dispatched ` +
        `'${provider}' sessions until it re-attests as logged in (run 'agentic-kanban-worker doctor' for detail).`,
    );
  }
  return attested;
}

/** `attestProviders` plus the no-usable-provider notice (#1372): what to advertise and why it may be nothing. */
export async function attestAndNotice(
  declared: string[],
  log: (line: string) => void,
  harness?: WorkerHarness,
): Promise<{ advertised: string[]; notice: string | undefined }> {
  const excluded: Array<{ provider: string; reason: string }> = [];
  const advertised = await attestProviders(declared, log, harness, excluded);
  return { advertised, notice: noUsableProviderNotice(declared, advertised, excluded) };
}