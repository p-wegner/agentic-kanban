/**
 * Pure, client-safe linter for a SIBLING repo's docker-compose file merged into a
 * workspace stack via an additional `-f` (the #71 multi-repo feature).
 *
 * THE SHARP EDGE (dev #109): `docker compose -f <leading> -f <sibling> …` resolves EVERY
 * relative path in EVERY `-f` file against ONE project directory — the directory of the
 * FIRST `-f` (the LEADING repo worktree) — never the file's own directory. So a sibling
 * compose that uses a relative `env_file:`, a relative top-level `secrets:`/`configs:`
 * `file:`, or a relative `build:` context points compose at `<leading>/<path>` while the
 * file actually lives in the sibling worktree. `up` then fails with a message that
 * misattributes the missing file to the leading repo — impossible to diagnose.
 *
 * Compose exposes NO CLI flag to make each `-f` file resolve relative to its own dir
 * (single project-directory rule), so the board cannot make this work transparently. The
 * proportionate mitigation is DIAGNOSTIC: detect these relative-path directives in a
 * sibling compose and surface a clear, actionable warning up front. Absolute paths and
 * `${VAR}` interpolations are fine (compose resolves them without the project dir), so
 * they are never flagged — keeping false positives near zero and the success path silent.
 *
 * Pure text scan (not a full YAML parse), mirroring `discoverComposePortNames` — good
 * enough to catch the realistic forms (`env_file: ./x`, `build: .`, `file: ../s.txt`)
 * with no Node dependency, so it stays value-exportable from the shared lib barrel.
 */

/** One relative-path directive found in a sibling compose that will misresolve. */
export interface SiblingComposeRelativePath {
  /** The directive keyword: `env_file`, `context`, or `file`. */
  directive: "env_file" | "context" | "file";
  /** The relative path value as written in the compose file. */
  value: string;
}

/** A value is a relative FILESYSTEM path (compose resolves it against the project dir). */
function isRelativePathValue(raw: string): boolean {
  let v = raw.trim();
  if (v.length === 0) return false;
  // Strip surrounding quotes.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  if (v.length === 0) return false;
  // Interpolated / env-driven values are resolved by compose without the project dir.
  if (v.includes("${") || v.startsWith("$")) return false;
  // POSIX-absolute (`/etc/x`) or Windows-absolute (`C:\x`, `C:/x`) — no project-dir join.
  if (v.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(v)) return false;
  // UNC path.
  if (v.startsWith("\\\\")) return false;
  // Explicit relative (`./x`, `../x`, `.env`) or a bare relative path (`build`, `a/b`).
  return true;
}

/**
 * Scan a sibling compose file's text for relative `env_file:`, `build:` context, and
 * top-level/service `secrets:`/`configs:` `file:` directives that compose will resolve
 * against the LEADING worktree instead of the sibling's own dir. Best-effort, line-based.
 *
 * Handles the common shapes:
 *  - `env_file: ./x` and `env_file:` followed by a `- ./x` list
 *  - `build: ./x` (shorthand) and `context: ./x`
 *  - `file: ./secret.txt` (secrets/configs source)
 */
export function findSiblingComposeRelativePaths(composeText: string): SiblingComposeRelativePath[] {
  const found: SiblingComposeRelativePath[] = [];
  const lines = composeText.split(/\r?\n/);
  let pendingListDirective: "env_file" | null = null;
  let pendingListIndent = -1;

  for (const line of lines) {
    // Skip full-line comments.
    const noComment = line.replace(/\s+#.*$/, "");
    const trimmed = noComment.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = noComment.length - noComment.trimStart().length;

    // Continuation of an `env_file:` block list (`- ./x`).
    if (pendingListDirective && trimmed.startsWith("-") && indent > pendingListIndent) {
      const item = trimmed.replace(/^-\s*/, "");
      if (isRelativePathValue(item)) found.push({ directive: pendingListDirective, value: stripQuotes(item) });
      continue;
    }
    pendingListDirective = null;

    const inline = /^(env_file|context|file|build)\s*:\s*(.*)$/.exec(trimmed);
    if (!inline) continue;
    const key = inline[1];
    const rest = inline[2].trim();

    if (key === "build") {
      // `build: ./x` shorthand only; the `build:`-block `context:` is caught by the
      // `context` case on its own line.
      if (rest.length > 0 && !rest.startsWith("#") && isRelativePathValue(rest)) {
        found.push({ directive: "context", value: stripQuotes(rest) });
      }
      continue;
    }
    if (key === "env_file" && rest.length === 0) {
      // Block-list form: subsequent `- ./x` lines belong to this directive.
      pendingListDirective = "env_file";
      pendingListIndent = indent;
      continue;
    }
    // Inline scalar (`env_file: ./x`, `context: ./x`, `file: ./x`).
    if (rest.length > 0 && isRelativePathValue(rest)) {
      found.push({ directive: key as "env_file" | "context" | "file", value: stripQuotes(rest) });
    }
  }
  return found;
}

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * Build the human-facing warning for a sibling compose whose relative paths will
 * misresolve against the leading worktree. Returns null when there is nothing to warn
 * about, so the success path stays silent.
 */
export function siblingComposeRelativePathWarning(args: {
  siblingName: string;
  siblingComposeAbsPath: string;
  leadingWorktreePath: string;
  issues: SiblingComposeRelativePath[];
}): string | null {
  if (args.issues.length === 0) return null;
  const list = args.issues.map((i) => `${i.directive}: ${i.value}`).join(", ");
  return (
    `[services] sibling '${args.siblingName}' compose (${args.siblingComposeAbsPath}) declares relative path(s) [${list}]. ` +
    `docker compose resolves relative env_file/build-context/secret+config file paths against the LEADING repo worktree ` +
    `(${args.leadingWorktreePath}) — NOT the sibling's own directory — because a multi-'-f' invocation has ONE project ` +
    `directory (the first -f). The sibling stack will fail 'up' with a file-not-found under the leading repo (dev #109). ` +
    `Use an ABSOLUTE path in the sibling compose, or move the stack into the leading repo's compose.`
  );
}
