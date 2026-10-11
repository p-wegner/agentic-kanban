// The worker's doctor results, compact, as they travel worker -> board (#1370): the summary shape,
// its wire parser, the summariser the daemon runs over its own doctor report, and the signature the
// daemon uses to send it only when it changes. Pure and node-free: the client imports the types.
// `worker-protocol.ts` re-exports everything here and `WorkerCapabilities.doctor` carries it.

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
/** One doctor check as the worker reports it to the board (#1370). Never carries a secret. */
export interface WorkerDoctorCheckSummary {
  /** The check's name, e.g. `git` or `claude auth`. */
  id: string;
  status: "pass" | "warn" | "fail" | "skip" | "unknown";
  /** One line, truncated. */
  message: string;
  /** The command/step that fixes it; omitted when nothing is actionable. */
  fix?: string;
}

export type WorkerDoctorCredentialState = "ok" | "expired" | "missing" | "unknown";

export interface WorkerDoctorSummary {
  checks: WorkerDoctorCheckSummary[];
  /** ISO stamp of the run that produced this. */
  checkedAt: string;
  /** Per declared provider: can this machine authenticate as it? Names and states only. */
  providers?: Array<{ provider: string; credential: WorkerDoctorCredentialState }>;
  /** Which provider-config mode the worker runs in (#1367). Absent = not reported. */
  harnessMode?: "clean" | "custom" | "inherit";
}

const DOCTOR_STATUSES = ["pass", "warn", "fail", "skip", "unknown"] as const;
const DOCTOR_CREDENTIALS = ["ok", "expired", "missing", "unknown"] as const;
const DOCTOR_MAX_CHECKS = 60;
const DOCTOR_MAX_TEXT = 400;

/** The raw doctor check shape `summarizeDoctorChecks` reads (the worker's `DoctorCheck`). */
export interface WorkerDoctorRawCheck {
  name: string;
  status: WorkerDoctorCheckSummary["status"];
  detail: string;
  remedy?: string;
}

/** Strip anything token-shaped from a doctor line before it leaves the machine. */
function redactDoctorText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g, "<redacted>");
}

/**
 * Reduce the worker's doctor report to the compact summary the board stores (#1370): id, status, the
 * first line of the message and of the fix, nothing else. `providers` is the DECLARED provider list;
 * each gets a credential state read off its `<p> CLI installed` / `<p> logged in` checks.
 */
export function summarizeDoctorChecks(
  checks: readonly WorkerDoctorRawCheck[],
  opts: { providers?: readonly string[]; harnessMode?: WorkerDoctorSummary["harnessMode"]; now?: string } = {},
): WorkerDoctorSummary {
  const oneLine = (v: string): string => redactDoctorText(v.split(/\r?\n/)[0] ?? "").trim();
  const providers = (opts.providers ?? []).map((provider) => {
    const installed = checks.find((c) => c.name === `${provider} CLI installed`);
    const login = checks.find((c) => c.name === `${provider} logged in`);
    const credential: WorkerDoctorCredentialState =
      installed?.status === "fail" ? "missing"
      : login?.status === "pass" ? "ok"
      : login?.status === "unknown" || login?.status === "fail" ? "missing"
      : "unknown";
    return { provider, credential };
  });
  return {
    checks: checks.slice(0, DOCTOR_MAX_CHECKS).map((c) => ({
      id: c.name,
      status: c.status,
      message: oneLine(c.detail),
      ...(c.remedy ? { fix: oneLine(c.remedy) } : {}),
    })),
    checkedAt: opts.now ?? new Date().toISOString(),
    ...(providers.length > 0 ? { providers } : {}),
    ...(opts.harnessMode ? { harnessMode: opts.harnessMode } : {}),
  };
}

/** Identity of a summary ignoring its timestamp: equal signatures mean "nothing changed" (#1370). */
export function doctorSignature(summary: WorkerDoctorSummary): string {
  return JSON.stringify({ ...summary, checkedAt: "" });
}

/** Shape-check a doctor summary off the wire (#1370). Malformed = absent; entries are clamped. */
export function parseWorkerDoctorSummary(raw: unknown): WorkerDoctorSummary | undefined {
  const rec = asRecord(raw);
  if (!rec || !Array.isArray(rec.checks)) return undefined;
  const clamp = (v: string): string => (v.length > DOCTOR_MAX_TEXT ? `${v.slice(0, DOCTOR_MAX_TEXT - 1)}…` : v);
  const checks: WorkerDoctorCheckSummary[] = [];
  for (const item of rec.checks.slice(0, DOCTOR_MAX_CHECKS)) {
    const c = asRecord(item);
    if (!c || typeof c.id !== "string" || !c.id.trim()) continue;
    const status = (DOCTOR_STATUSES as readonly unknown[]).includes(c.status)
      ? (c.status as WorkerDoctorCheckSummary["status"])
      : "unknown";
    checks.push({
      id: clamp(c.id.trim()),
      status,
      message: typeof c.message === "string" ? clamp(c.message) : "",
      ...(typeof c.fix === "string" && c.fix.trim() ? { fix: clamp(c.fix.trim()) } : {}),
    });
  }
  const providers: NonNullable<WorkerDoctorSummary["providers"]> = [];
  for (const item of Array.isArray(rec.providers) ? rec.providers.slice(0, 16) : []) {
    const p = asRecord(item);
    if (!p || typeof p.provider !== "string" || !p.provider.trim()) continue;
    providers.push({
      provider: clamp(p.provider.trim()),
      credential: (DOCTOR_CREDENTIALS as readonly unknown[]).includes(p.credential)
        ? (p.credential as WorkerDoctorCredentialState)
        : "unknown",
    });
  }
  const harnessMode =
    rec.harnessMode === "clean" || rec.harnessMode === "custom" || rec.harnessMode === "inherit"
      ? rec.harnessMode
      : undefined;
  return {
    checks,
    checkedAt: typeof rec.checkedAt === "string" ? rec.checkedAt : "",
    ...(providers.length > 0 ? { providers } : {}),
    ...(harnessMode ? { harnessMode } : {}),
  };
}
