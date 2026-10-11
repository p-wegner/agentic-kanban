// Worker prerequisites a clean machine may lack (#1369): the committer identity the board sends and
// the package managers a worker reports. Split out of worker-protocol.ts (god-module ceiling); the
// protocol file imports the types and parsers it needs and re-exports them.

/** A git committer identity as the board sends it in an assignment (#1369). */
export interface WorkerCommitterIdentity {
  name: string;
  email: string;
}

/**
 * Which package managers a worker has on PATH (#1369), reported on every heartbeat so
 * placement can say "this project's lockfile needs pnpm and this worker has none". Absent
 * on the wire = an older worker that said nothing, which is unknown and never "has none".
 */
export interface WorkerPackageManagers {
  pnpm: boolean;
  yarn: boolean;
  bun: boolean;
  corepack: boolean;
}

/**
 * What an assignment's fallback install needs for a project, from its lockfile (#1369):
 * the marker rules of `deriveFallbackSetupCommand`, as a name. `npm` ships with node, so it
 * is never a prerequisite worth reporting and maps to null.
 */
export function packageManagerForLockfiles(files: ReadonlySet<string> | readonly string[]): "pnpm" | "yarn" | "bun" | null {
  const has = (name: string): boolean => (files instanceof Set ? files.has(name) : (files as readonly string[]).includes(name));
  if (has("pnpm-lock.yaml") || has("pnpm-workspace.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  return null;
}

/** Shape-check a package-manager blob off the wire (#1369). Anything malformed reads as unknown. */
export function parseWorkerPackageManagers(raw: unknown): WorkerPackageManagers | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const keys = ["pnpm", "yarn", "bun", "corepack"] as const;
  if (!keys.every((k) => typeof rec[k] === "boolean")) return undefined;
  return { pnpm: rec.pnpm as boolean, yarn: rec.yarn as boolean, bun: rec.bun as boolean, corepack: rec.corepack as boolean };
}

/** Shape-check a committer identity off the wire; both halves must be non-empty strings. */
export function parseWorkerCommitterIdentity(raw: unknown): WorkerCommitterIdentity | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const email = typeof rec.email === "string" ? rec.email.trim() : "";
  return name && email ? { name, email } : undefined;
}
