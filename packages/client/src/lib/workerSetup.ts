/**
 * The pure core of the Runners tab's per-worker "Setup" section (#1370): what a worker's doctor
 * results, providers and attested profiles add up to. A paired worker that is not logged in must
 * not read as `online` — `needsSetup` is what makes the row say so.
 */
import type {
  WorkerDoctorCheckSummary,
  WorkerDoctorCredentialState,
  WorkerDoctorSummary,
  WorkerProfileAttestation,
} from "@agentic-kanban/shared/lib/worker-protocol";

export interface WorkerSetupInput {
  effectiveStatus: "online" | "draining" | "offline";
  providers: string[];
  doctor?: WorkerDoctorSummary;
  attestedProfiles?: WorkerProfileAttestation[];
}

export interface ProviderCredentialRow {
  provider: string;
  credential: WorkerDoctorCredentialState;
}

export interface WorkerSetupState {
  needsSetup: boolean;
  /** Why, one phrase each — shown next to the badge. */
  reasons: string[];
  failing: WorkerDoctorCheckSummary[];
  warning: WorkerDoctorCheckSummary[];
  providers: ProviderCredentialRow[];
}

const WORSE: Record<WorkerDoctorCredentialState, number> = { ok: 0, unknown: 1, missing: 2, expired: 3 };

/**
 * Credential state per provider: the worker's doctor reading, overridden by what its attested
 * profiles say when EVERY profile of that provider is expired/missing (the board's own placement
 * skips such profiles, so the provider is not usable even if its CLI is logged in somewhere).
 */
export function providerCredentials(input: WorkerSetupInput): ProviderCredentialRow[] {
  const fromDoctor = new Map((input.doctor?.providers ?? []).map((p) => [p.provider, p.credential]));
  const names = [...new Set([...input.providers, ...fromDoctor.keys()])];
  return names.map((provider) => {
    let credential: WorkerDoctorCredentialState = fromDoctor.get(provider) ?? (input.providers.includes(provider) ? "ok" : "unknown");
    const profiles = (input.attestedProfiles ?? []).filter((p) => p.provider === provider);
    if (profiles.length > 0 && profiles.every((p) => p.credentials)) {
      const worst = profiles.reduce<WorkerDoctorCredentialState>(
        (acc, p) => (WORSE[p.credentials as WorkerDoctorCredentialState] > WORSE[acc] ? (p.credentials as WorkerDoctorCredentialState) : acc),
        "ok",
      );
      credential = worst;
    }
    return { provider, credential };
  });
}

export function workerSetupState(input: WorkerSetupInput): WorkerSetupState {
  const checks = input.doctor?.checks ?? [];
  const failing = checks.filter((c) => c.status === "fail");
  const warning = checks.filter((c) => c.status === "warn");
  const providers = providerCredentials(input);
  const reasons: string[] = [];
  if (failing.length > 0) reasons.push(`${failing.length} failing check${failing.length === 1 ? "" : "s"}`);
  if (providers.length === 0) reasons.push("no provider declared");
  else if (!providers.some((p) => p.credential === "ok")) reasons.push("no usable provider");
  return { needsSetup: input.effectiveStatus !== "offline" && reasons.length > 0, reasons, failing, warning, providers };
}

/** Swap the connect-info placeholders for the minted token and the fleet URL the CLI would print. */
export function fillBootstrapLine(
  line: string,
  fill: { placeholderToken: string; token: string; placeholderUrl: string; url: string },
): string {
  const url = fill.url.replace(/\/+$/, "");
  return line.split(fill.placeholderToken).join(fill.token).split(fill.placeholderUrl.replace(/\/+$/, "")).join(url);
}
