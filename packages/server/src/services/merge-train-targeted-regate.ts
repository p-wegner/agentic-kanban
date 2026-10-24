/**
 * #1633 - the TARGETED re-gate after a shepherd fix. A full train gate costs 30-40 min; a one-file
 * fix does not need it. Pure decision + script building: the caller supplies the fix's changed files
 * and the files/packages the first gate covered, and gets back either a targeted verify script or the
 * reason the full gate must run. Only promotion requires a full run (the rc sweep is the safety net).
 */

/** More changed files than this and the fix is no longer "small". */
export const TARGETED_REGATE_MAX_FILES = 8;

/** A fix touching any of these changes what the gate itself is - never narrow the gate for it. */
const SCOPE_BREAKERS: RegExp[] = [
  /^pnpm-lock\.yaml$/, /^package\.json$/, /^pnpm-workspace\.yaml$/, /^tsconfig[^/]*\.json$/,
  /^vitest[^/]*\.(?:ts|mts|js|mjs)$/, /^scripts\//, /^\.github\//, /^\.claude\/(?:settings|hooks)/,
  /(?:^|\/)vitest\.config\.[^/]+$/, /(?:^|\/)package\.json$/,
];

export function isScopeBreaker(file: string): boolean {
  const f = file.replace(/\\/g, "/");
  return SCOPE_BREAKERS.some((re) => re.test(f)) || /(?:^|\/)pre-merge-gate[^/]*\.ts$/.test(f) || /(?:^|\/)test-mine\.mjs$/.test(f);
}

/** `packages/<name>/...` -> `packages/<name>`; anything else is the repo root bucket. */
export function packageOf(file: string): string {
  const m = /^(packages\/[^/]+)\//.exec(file.replace(/\\/g, "/"));
  return m ? m[1] : ".";
}

export type RegateDecision =
  | { mode: "full"; reason: string }
  | { mode: "targeted"; script: string; files: string[]; failingSuites: string[]; staticChecks: boolean; fixSha: string; gatedSha: string };

const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/;
// The script runs under `spawn(..., { shell: true })` on the worker: cmd.exe on Windows, sh elsewhere.
// cmd keeps POSIX single quotes literally (`cd 'packages/server'` failed, 2026-10-23), so a token goes in
// unquoted and only when it means the same to both shells; anything else forces the full gate.
const SHELL_SAFE = /^[\w./@:+=-]+$/;

export function decideRegate(args: {
  /** Files changed by the shepherd's commits on top of the gated train sha. */
  fixFiles: readonly string[];
  /** Files the first gate covered (the members' changed files); packages are derived from them. */
  coveredFiles: readonly string[];
  failedSuites?: readonly string[];
  gatedSha: string;
  fixSha: string;
  maxFiles?: number;
}): RegateDecision {
  const files = [...new Set(args.fixFiles.map((f) => f.replace(/\\/g, "/")))];
  const max = args.maxFiles ?? TARGETED_REGATE_MAX_FILES;
  if (files.length === 0) return { mode: "full", reason: "fix diff unknown or empty" };
  const breaker = files.find(isScopeBreaker);
  if (breaker) return { mode: "full", reason: `fix touches scope breaker ${breaker}` };
  if (files.length > max) return { mode: "full", reason: `fix touches ${files.length} files (> ${max})` };
  const covered = new Set(args.coveredFiles.map(packageOf));
  const outside = files.find((f) => !covered.has(packageOf(f)));
  if (outside) return { mode: "full", reason: `fix touches ${packageOf(outside)}, which the first gate did not cover` };

  const failing = [...new Set(args.failedSuites ?? [])];
  const unsafe = [args.gatedSha, ...covered, ...failing].find((t) => !SHELL_SAFE.test(t.replace(/\\/g, "/")));
  if (unsafe) return { mode: "full", reason: `${unsafe} is not shell-safe for the worker's shell` };
  const staticChecks = files.some((f) => SOURCE_RE.test(f));
  const steps: string[] = [];
  if (staticChecks) steps.push("pnpm check:arch", "pnpm typecheck");
  if (failing.length > 0) {
    // #1656: vitest lives in the packages, not the root - run each suite inside its own package.
    const pkgs = [...covered].filter((p) => p !== ".");
    const byPkg = new Map<string, string[]>();
    for (const raw of failing) {
      const suite = raw.replace(/\\/g, "/");
      const m = /^(packages\/[^/]+)\/(.+)$/.exec(suite);
      const pkg = m ? m[1] : pkgs.length === 1 ? pkgs[0] : null;
      if (!pkg) return { mode: "full", reason: `failing suite ${raw} cannot be mapped to a package` };
      byPkg.set(pkg, [...(byPkg.get(pkg) ?? []), m ? m[2] : suite]);
    }
    for (const [pkg, suites] of byPkg) steps.push(`(cd ${pkg} && pnpm exec vitest run --maxWorkers=4 ${suites.join(" ")})`);
  }
  // Related suites + the always-run guards whose `when:` globs match the fix: test:mine scoped to the fix diff.
  steps.push(`pnpm test:mine -- --changed ${args.gatedSha}`);
  return { mode: "targeted", script: steps.join(" && "), files, failingSuites: failing, staticChecks, fixSha: args.fixSha, gatedSha: args.gatedSha };
}

/** Gate-evidence label; never reads like a full gate. */
export function describeTargetedRegate(d: Extract<RegateDecision, { mode: "targeted" }>, counts?: { related?: number; guards?: number }): string {
  const parts = [`failing ${d.failingSuites.length}`, `related ${counts?.related ?? d.files.length}`, ...(counts?.guards != null ? [`guards ${counts.guards}`] : [])];
  return `re-gate: targeted (${parts.join(" + ")}) after shepherd fix ${d.fixSha.slice(0, 7)}`;
}

export function describeFullRegate(reason: string): string {
  return `re-gate: full (${reason})`;
}

/** Per-train phase timings (ms) for the train record and `status --watch`. */
export interface TrainTimings { assemblyMs?: number; gateMs?: number; shepherdMs?: number; regateMs?: number; landMs?: number }

export function formatTrainTimings(t: TrainTimings): string {
  const fmt = (ms?: number): string | null => (ms == null ? null : ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);
  return (["assembly", "gate", "shepherd", "regate", "land"] as const)
    .map((k) => { const v = fmt(t[`${k}Ms` as keyof TrainTimings]); return v ? `${k} ${v}` : null; })
    .filter(Boolean).join(" · ");
}

/** #1656: the gate died on a missing tool or a missing directory and ran no test - infrastructure, never the train's red. */
export function isMissingToolNoTests(gate: { passed: boolean; message: string; failedSuites?: readonly string[] }): boolean {
  if (gate.passed || (gate.failedSuites?.length ?? 0) > 0) return false;
  return /Command "?vitest"? not found|ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL|vitest(?:["']|\s)+(?:ist entweder falsch|is not recognized|: command not found|: not found)|Der Befehl "vitest"|Das System kann den angegebenen Pfad nicht finden|The system cannot find the path specified|cd: [^\n]*: No such file or directory/i.test(gate.message);
}
