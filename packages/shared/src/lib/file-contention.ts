/**
 * Shared-registration-file contention detection (#119) — the "serialize" half of
 * the parallelism-tax fix.
 *
 * Observed independently in all three foundation-build dogfood projects
 * (taskflow/TS, bookvault/Python, shopcart/Kotlin): every domain feature must
 * register itself in a shared wiring file (`src/app.ts` routes,
 * `app/main.py` + `app/models/__init__.py`, `Application.kt` +
 * `DatabaseFactory.kt`). So the SECOND of any two concurrent builders always
 * conflicts on that file and needs an agent-based fix-and-merge cycle — a
 * genuine adjacent-line content conflict that `update-base` rebase cannot
 * auto-resolve. Parallel throughput was gated by this contention, not by
 * ticket sizing.
 *
 * This module answers ONE question for the auto-start gate: given a candidate
 * ticket's predicted touched files and the predicted files of the tickets
 * already in flight, would starting it now collide on a registration/hot file?
 *
 * Deliberately NOT `computeCouplingCandidates` (coupling-overlap.ts). That
 * computes a Szymkiewicz–Simpson coefficient over the *whole* footprint and
 * requires >= 0.5 overlap — it answers "should these two tickets be ONE
 * ticket?". Contention is a different shape: two tickets with 8 predicted files
 * each that share exactly ONE registration file score 0.125 and are correctly
 * NOT coupling candidates, yet they WILL conflict. Hence a separate, narrower
 * rule keyed on the hotness of the shared file rather than on overlap breadth.
 *
 * PURE (no node builtins, no DB) so it is client-bundle safe and unit-testable
 * in isolation.
 */

/** One issue's predicted touched files, as needed for contention analysis. */
export interface ContentionIssueFiles {
  issueId: string;
  /** Distinct predicted file paths (raw; normalised internally). */
  files: string[];
}

export interface ContentionOptions {
  /**
   * A file predicted by at least this many issues in the project is treated as
   * hot even if its name matches no registration pattern — empirical hotness
   * catches project-specific wiring files the name list can't know about
   * (e.g. `src/di/container.ts`, `internal/wire.go`). Default 3.
   */
  hotFileMinIssues?: number;
  /**
   * Extra file paths (or basenames) to always treat as hot, e.g. from a
   * per-project setting. Normalised and matched the same way as predictions.
   */
  extraHotFiles?: string[];
}

export interface ContentionVerdict {
  /** True when the candidate shares at least one HOT file with an in-flight issue. */
  serialize: boolean;
  /** The hot files driving the verdict, sorted. Empty when `serialize` is false. */
  hotFiles: string[];
  /** Every file shared with any in-flight issue (hot or not), sorted. */
  sharedFiles: string[];
  /** In-flight issue ids the candidate contends with on a HOT file, sorted. */
  blockingIssueIds: string[];
}

export const DEFAULT_HOT_FILE_MIN_ISSUES = 3;

/**
 * Basenames that are registration/wiring files across the stacks the board
 * builds for. These are the files where "add my feature to the list" edits land
 * adjacent to each other and conflict.
 */
const REGISTRATION_BASENAMES = new Set([
  // TS / JS
  "app.ts", "app.js", "main.ts", "main.js", "index.ts", "index.js",
  "server.ts", "server.js", "routes.ts", "routes.js", "router.ts", "router.js",
  "schema.ts", "container.ts", "registry.ts",
  // Python
  "app.py", "main.py", "__init__.py", "urls.py", "settings.py", "models.py",
  // Kotlin / Java
  "application.kt", "databasefactory.kt", "application.java",
  // Go
  "main.go", "routes.go", "wire.go",
  // Rust
  "main.rs", "lib.rs", "mod.rs",
]);

/**
 * Suffix patterns for registration files whose basename varies per project
 * (`AppModule.kt`, `app.module.ts`, `DatabaseConfig.kt`, …).
 */
const REGISTRATION_SUFFIXES = [
  ".module.ts", ".module.js",
  "module.kt", "module.java",
  "config.kt", "config.java",
  "factory.kt", "factory.java",
];

/** Normalise a predicted path: slashes, trim, strip a leading `./`. */
export function normalizeContentionPath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return (i === -1 ? path : path.slice(i + 1)).toLowerCase();
}

/**
 * True when a path looks like a shared registration/wiring file by NAME alone.
 * Name-based detection is a heuristic, so it is only half the signal — see
 * {@link computeHotFiles}, which ORs it with empirical cross-issue hotness.
 */
export function isRegistrationFile(path: string): boolean {
  const base = basename(normalizeContentionPath(path));
  if (!base) return false;
  if (REGISTRATION_BASENAMES.has(base)) return true;
  return REGISTRATION_SUFFIXES.some((s) => base.endsWith(s) && base !== s);
}

function fileSet(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const n = normalizeContentionPath(f);
    if (n) out.add(n);
  }
  return out;
}

/**
 * The set of hot files for a project: every file that is either name-detected as
 * a registration file, listed in `extraHotFiles`, or predicted by at least
 * `hotFileMinIssues` distinct issues.
 *
 * Pass ALL of the project's issues with predictions (not just the in-flight
 * ones) so the empirical signal has enough evidence to work with.
 */
export function computeHotFiles(
  issues: ContentionIssueFiles[],
  options: ContentionOptions = {},
): Set<string> {
  const minIssues = Math.max(2, options.hotFileMinIssues ?? DEFAULT_HOT_FILE_MIN_ISSUES);
  const counts = new Map<string, number>();
  for (const issue of issues) {
    for (const f of fileSet(issue.files)) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }

  const hot = new Set<string>();
  for (const [file, count] of counts) {
    if (count >= minIssues || isRegistrationFile(file)) hot.add(file);
  }
  for (const extra of fileSet(options.extraHotFiles ?? [])) hot.add(extra);
  return hot;
}

/**
 * Decide whether starting `candidate` right now would contend with any of the
 * `inFlight` issues on a hot/registration file.
 *
 * Fail-open by design: an issue with NO cached prediction contributes nothing
 * and never causes a defer. `analyzeTouchedFiles` makes an LLM call on cache
 * miss, so the auto-start gate must never depend on a prediction existing — an
 * unpredicted ticket starts exactly as it does today.
 *
 * `hotFiles` is passed in rather than recomputed so the caller can derive it
 * once per project from the full issue set (see {@link computeHotFiles}).
 */
export function assessFileContention(
  candidate: ContentionIssueFiles,
  inFlight: ContentionIssueFiles[],
  hotFiles: ReadonlySet<string>,
): ContentionVerdict {
  const empty: ContentionVerdict = { serialize: false, hotFiles: [], sharedFiles: [], blockingIssueIds: [] };
  const candidateFiles = fileSet(candidate.files);
  if (candidateFiles.size === 0) return empty;

  const shared = new Set<string>();
  const hot = new Set<string>();
  const blocking = new Set<string>();

  for (const other of inFlight) {
    if (other.issueId === candidate.issueId) continue;
    const otherFiles = fileSet(other.files);
    if (otherFiles.size === 0) continue;
    for (const f of candidateFiles) {
      if (!otherFiles.has(f)) continue;
      shared.add(f);
      if (hotFiles.has(f)) {
        hot.add(f);
        blocking.add(other.issueId);
      }
    }
  }

  return {
    serialize: hot.size > 0,
    hotFiles: [...hot].sort(),
    sharedFiles: [...shared].sort(),
    blockingIssueIds: [...blocking].sort(),
  };
}

/** How the auto-start gate reacts to detected contention. */
export type FileContentionMode = "off" | "warn" | "serialize";

/**
 * Resolve the `file_contention_<projectId>` preference.
 *
 * Defaults to `"serialize"` — unlike the auto-contract gate this is safe to have
 * on by default because it only DEFERS a start to a later cycle (the ticket
 * launches as soon as the contending workspace lands) and it fails open whenever
 * predictions are missing.
 */
export function resolveFileContentionMode(value: string | undefined): FileContentionMode {
  switch ((value ?? "").trim().toLowerCase()) {
    case "off":
    case "false":
      return "off";
    case "warn":
    case "suggest":
      return "warn";
    default:
      return "serialize";
  }
}
