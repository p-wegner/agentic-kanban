// Toolchains a worker reports and a project requires (#1382). Pure: the worker's probing lives in
// the server package, this file holds the wire shape, the requirement grammar (`pnpm, java>=21`) and
// the matcher, so the board, the worker and the settings UI all read a requirement the same way.

/**
 * What a worker detected on its PATH, keyed by toolchain name. The value is the version string the
 * probe parsed (`"21.0.4"`), or `""` when the tool is present but its version was not recognised.
 * A key that is absent is "not found"; the whole blob being absent on the wire is an older worker
 * that said nothing, which is UNKNOWN and never "has none" (same convention as #1369).
 */
export type WorkerToolchains = Record<string, string>;

/** The toolchain names a worker probes for; anything else off the wire is dropped. */
export const KNOWN_TOOLCHAINS = [
  "node", "pnpm", "yarn", "bun", "java", "gradle", "maven", "go", "python", "uv", "docker",
] as const;
export type ToolchainName = (typeof KNOWN_TOOLCHAINS)[number];

/** Prefix that smuggles a toolchain requirement through the placement `requiredLabels` list. */
export const TOOLCHAIN_REQUIREMENT_PREFIX = "toolchain:";

/** Shape-check a toolchains blob off the wire. Anything malformed reads as unknown (undefined). */
export function parseWorkerToolchains(raw: unknown): WorkerToolchains | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: WorkerToolchains = {};
  for (const [name, version] of Object.entries(raw as Record<string, unknown>)) {
    if (!(KNOWN_TOOLCHAINS as readonly string[]).includes(name)) continue;
    if (typeof version !== "string") continue;
    out[name] = version.trim().slice(0, 40);
  }
  return out;
}

export interface ToolchainRequirement {
  name: string;
  /** Only `>=` is supported: "at least this version". Absent = any version. */
  minVersion?: string;
}

/** Canonical text of a requirement: `java>=21`, `pnpm`. */
export function formatToolchainRequirement(req: ToolchainRequirement): string {
  return req.minVersion ? `${req.name}>=${req.minVersion}` : req.name;
}

/** One `name` or `name>=version` token, or null when it is not one. */
export function parseToolchainRequirement(token: string): ToolchainRequirement | null {
  const m = /^([a-z][a-z0-9_-]*)\s*(?:>=\s*(\d+(?:\.\d+)*))?$/i.exec(token.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), ...(m[2] ? { minVersion: m[2] } : {}) };
}

/** A `required_toolchains` value (CSV, whitespace tolerated). Unparseable tokens are dropped, duplicates merged. */
export function parseRequiredToolchains(pref: string | undefined | null): ToolchainRequirement[] {
  const byName = new Map<string, ToolchainRequirement>();
  for (const token of (pref ?? "").split(/[,\n]/)) {
    const req = parseToolchainRequirement(token);
    if (!req) continue;
    const prev = byName.get(req.name);
    // Two entries for one tool: the stricter minimum wins.
    if (!prev || (req.minVersion && (!prev.minVersion || compareVersions(req.minVersion, prev.minVersion) > 0))) {
      byName.set(req.name, req);
    }
  }
  return [...byName.values()];
}

/** Numeric dotted-version compare: negative, 0, positive. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Does a reported toolchain set satisfy one requirement? A present tool of unknown version fails a `>=`. */
export function toolchainSatisfies(have: WorkerToolchains, req: ToolchainRequirement): boolean {
  const version = have[req.name];
  if (version === undefined) return false;
  if (!req.minVersion) return true;
  return version !== "" && compareVersions(version, req.minVersion) >= 0;
}

/**
 * The requirements a worker's report does not meet, as text (`java>=21`). A worker that reported no
 * toolchains at all (`have` undefined) is unknown, not lacking: it yields nothing.
 */
export function missingToolchains(required: readonly ToolchainRequirement[], have: WorkerToolchains | undefined): string[] {
  if (!have) return [];
  return required.filter((r) => !toolchainSatisfies(have, r)).map(formatToolchainRequirement);
}

/** Wrap a requirement list as pseudo-labels so it rides the existing `requiredLabels` plumbing. */
export function toolchainRequirementLabels(required: readonly ToolchainRequirement[]): string[] {
  return required.map((r) => `${TOOLCHAIN_REQUIREMENT_PREFIX}${formatToolchainRequirement(r)}`);
}

/** Split a placement requirement list into plain labels and toolchain requirements. */
export function splitRequirements(entries: readonly string[]): { labels: string[]; toolchains: ToolchainRequirement[] } {
  const labels: string[] = [];
  const toolchains: ToolchainRequirement[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(TOOLCHAIN_REQUIREMENT_PREFIX)) {
      labels.push(entry);
      continue;
    }
    const req = parseToolchainRequirement(entry.slice(TOOLCHAIN_REQUIREMENT_PREFIX.length));
    if (req) toolchains.push(req);
  }
  return { labels, toolchains };
}

/** Does a worker (its labels + reported toolchains) meet a placement requirement list? */
export function workerMeetsRequirements(
  requirements: readonly string[],
  labels: readonly string[],
  toolchains: WorkerToolchains | undefined,
): boolean {
  const split = splitRequirements(requirements);
  return split.labels.every((l) => labels.includes(l)) && missingToolchains(split.toolchains, toolchains).length === 0;
}

/** One-line rendering for the fleet UI and explain output: `node 22.1, pnpm 9.1, java 21`. */
export function formatWorkerToolchains(have: WorkerToolchains): string {
  const parts = Object.entries(have).map(([name, version]) => (version ? `${name} ${version}` : name));
  return parts.length > 0 ? parts.join(", ") : "none detected";
}

/** The first dotted number in a `--version` output: `openjdk version "21.0.4"` -> `21.0.4`. */
export function parseToolVersion(output: string): string {
  // Java 8 reports "1.8.0_392"; strip the legacy 1. so `java>=8` compares as expected.
  const quoted = /version\s+"(\d+(?:\.\d+)*)/.exec(output);
  const raw = quoted?.[1] ?? /(\d+(?:\.\d+)+|\d+)/.exec(output)?.[1] ?? "";
  return raw.startsWith("1.") && quoted ? raw.slice(2) : raw;
}

/** What a repo's files suggest it needs, for one-click acceptance in settings. `files` is the root listing. */
export function suggestToolchains(files: readonly string[], opts: { goMod?: string } = {}): ToolchainRequirement[] {
  const has = (f: string) => files.includes(f);
  const out: ToolchainRequirement[] = [];
  if (has("pnpm-lock.yaml")) out.push({ name: "pnpm" });
  else if (has("yarn.lock")) out.push({ name: "yarn" });
  else if (has("bun.lockb") || has("bun.lock")) out.push({ name: "bun" });
  else if (has("package.json")) out.push({ name: "node" });
  if (has("gradlew") || has("gradlew.bat") || has("build.gradle") || has("build.gradle.kts")) {
    out.push({ name: "java" });
  } else if (has("mvnw") || has("pom.xml")) {
    out.push({ name: "java" });
  }
  if (has("go.mod")) {
    const v = /^go\s+(\d+(?:\.\d+)*)/m.exec(opts.goMod ?? "")?.[1];
    out.push({ name: "go", ...(v ? { minVersion: v } : {}) });
  }
  if (has("uv.lock")) out.push({ name: "uv" });
  else if (has("pyproject.toml") || has("requirements.txt")) out.push({ name: "python" });
  if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yaml")) out.push({ name: "docker" });
  return out;
}
