// Install-on-request for project toolchains (#1371, stage 2 of #1382). Pure: the wire shapes of the
// two fleet frames, the worker's install policy, the policy matrix and the requirement -> mise spec
// mapping. The board decides whether to ASK; the worker's own policy decides whether to DO. Installing
// is code execution on the worker, so the board can never force it.
import { parseToolchainRequirement, type ToolchainRequirement } from "./worker-toolchains.js";

export const TOOLCHAIN_INSTALL_POLICIES = ["never", "ask", "auto"] as const;
export type ToolchainInstallPolicy = (typeof TOOLCHAIN_INSTALL_POLICIES)[number];

/** What a worker declares about its install policy, in hello + heartbeat capabilities. */
export interface WorkerToolchainInstallInfo {
  policy: ToolchainInstallPolicy;
  /** `auto` only installs these toolchain names (`java`, `go`, ...). */
  allow: string[];
  /** Is `mise` on this worker's PATH? Without it nothing can be installed (no winget/apt fallback). */
  mise: boolean;
}

export type ToolchainInstallState = "pending" | "installing" | "failed" | "done";

/** The worker's progress report for one install request, correlated by `requestId`. */
export interface ToolchainInstallStatus {
  requestId: string;
  state: ToolchainInstallState;
  /** The requirements this request covers, as text (`go>=1.23`). */
  toolchains: string[];
  /** Why it failed (or why it is still pending). */
  reason?: string;
}

/** Board -> worker: please install these (subject to your own policy). */
export interface ToolchainInstallRequestFrame {
  type: "toolchain_install";
  requestId: string;
  toolchains: string[];
}

export function parseToolchainInstallPolicy(raw: unknown): ToolchainInstallPolicy | undefined {
  return typeof raw === "string" && (TOOLCHAIN_INSTALL_POLICIES as readonly string[]).includes(raw)
    ? (raw as ToolchainInstallPolicy)
    : undefined;
}

/** `--toolchain-allow java,go` -> lower-cased unique names. */
export function parseToolchainAllowList(raw: string | readonly string[] | undefined | null): string[] {
  const parts = typeof raw === "string" ? raw.split(",") : [...(raw ?? [])];
  return [...new Set(parts.map((p) => p.trim().toLowerCase()).filter(Boolean))];
}

export function parseWorkerToolchainInstallInfo(raw: unknown): WorkerToolchainInstallInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const policy = parseToolchainInstallPolicy(rec.policy);
  if (!policy) return undefined;
  return {
    policy,
    allow: Array.isArray(rec.allow) ? parseToolchainAllowList(rec.allow.filter((a): a is string => typeof a === "string")) : [],
    mise: rec.mise === true,
  };
}

export function parseToolchainInstallStatus(raw: unknown): ToolchainInstallStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.requestId !== "string" || !rec.requestId) return null;
  if (!["pending", "installing", "failed", "done"].includes(rec.state as string)) return null;
  const toolchains = Array.isArray(rec.toolchains) ? rec.toolchains.filter((t): t is string => typeof t === "string").slice(0, 20) : [];
  return {
    requestId: rec.requestId,
    state: rec.state as ToolchainInstallState,
    toolchains,
    ...(typeof rec.reason === "string" && rec.reason ? { reason: rec.reason.slice(0, 500) } : {}),
  };
}

/** Toolchains mise cannot provide (a daemon, not a tool): never requested, never installed. */
const NOT_INSTALLABLE = new Set(["docker"]);

/** Can this requirement be satisfied through mise at all? */
export function isInstallableToolchain(name: string): boolean {
  return !NOT_INSTALLABLE.has(name);
}

/**
 * The mise tool spec for a requirement: `go>=1.23` -> `go@1.23`, `java>=21` -> `java@21`, `uv` -> `uv@latest`.
 * `>=` becomes the pinned minimum: mise resolves a prefix to the newest matching release, which satisfies it.
 */
export function miseSpecFor(req: ToolchainRequirement): string | null {
  if (!isInstallableToolchain(req.name)) return null;
  return `${req.name}@${req.minVersion ?? "latest"}`;
}

export type InstallDecision =
  | { action: "install" }
  | { action: "await-approval" }
  | { action: "blocked"; reason: string };

/**
 * The policy matrix: may a worker with this policy install these toolchains?
 * - `never`: blocked, and the reason names the policy.
 * - no mise: blocked (no fallback to winget/apt).
 * - `ask`: waits for the owner's approval on the worker.
 * - `auto`: installs only when EVERY requested toolchain is on the allowlist.
 */
export function decideToolchainInstall(
  info: WorkerToolchainInstallInfo | undefined,
  requested: readonly ToolchainRequirement[],
): InstallDecision {
  if (!info || info.policy === "never") {
    return { action: "blocked", reason: `worker install policy is "never" (start the worker with --toolchain-install=ask|auto to allow installs)` };
  }
  const uninstallable = requested.filter((r) => !isInstallableToolchain(r.name));
  if (uninstallable.length > 0) {
    return { action: "blocked", reason: `${uninstallable.map((r) => r.name).join(", ")} cannot be installed through mise; install it on the worker by hand` };
  }
  if (!info.mise) {
    return { action: "blocked", reason: "mise is not installed on the worker (install mise: https://mise.jdx.dev); there is no fallback to winget/apt" };
  }
  if (info.policy === "ask") return { action: "await-approval" };
  const notAllowed = requested.filter((r) => !info.allow.includes(r.name));
  if (notAllowed.length > 0) {
    return { action: "blocked", reason: `${notAllowed.map((r) => r.name).join(", ")} not on the worker's --toolchain-allow list (${info.allow.join(",") || "empty"})` };
  }
  return { action: "install" };
}

/** Parse request frame entries (`go>=1.23`) back into requirements, dropping junk. */
export function parseInstallRequirements(tokens: readonly string[]): ToolchainRequirement[] {
  return tokens.map((t) => parseToolchainRequirement(t)).filter((r): r is ToolchainRequirement => r !== null);
}
