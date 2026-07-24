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
  /** The directive keyword: `env_file`, `context`, `file`, `volume`, or `dockerfile`. */
  directive: "env_file" | "context" | "file" | "volume" | "dockerfile";
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
 * A relative bind-mount SOURCE from a `volumes:` list item, or null when the item is a
 * named-volume reference (`dbdata:/var/lib/...`, no leading `.`) or an absolute path —
 * neither of which compose resolves against the project directory.
 */
function extractVolumeBindSource(item: string): string | null {
  let v = item.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  if (v.length === 0) return null;
  // Windows-absolute drive source (`C:\x:/target`) — not relative, and its own colon
  // would otherwise be mistaken for the source/target separator.
  if (/^[A-Za-z]:[\\/]/.test(v)) return null;
  const idx = v.indexOf(":");
  if (idx === -1) return null; // a bare path with no target — not the SOURCE:TARGET form
  const source = v.slice(0, idx);
  // Only `./x` / `../x` is unambiguously a relative bind-mount source. A bare name
  // (`dbdata`) is a named volume — flagging it would be a false positive.
  return source.startsWith("./") || source.startsWith("../") ? source : null;
}

/**
 * Scan a sibling compose file's text for relative `env_file:`, `build:` context,
 * top-level/service `secrets:`/`configs:` `file:`, `volumes:` bind-mount sources, and
 * `dockerfile:` directives that compose will resolve against the LEADING worktree
 * instead of the sibling's own dir. Best-effort, line-based.
 *
 * Handles the common shapes:
 *  - `env_file: ./x`, `env_file:` followed by a `- ./x` list, and the long mapping form
 *    (`- path: ./x` \+ optional `required:`/other keys on following lines)
 *  - `build: ./x` (shorthand), `context: ./x`, and `dockerfile: ../x`
 *  - `file: ./secret.txt` (secrets/configs source)
 *  - `volumes:` list bind mounts, short form (`- ./seed:/target[:ro]`) and long form
 *    (`- type: bind` \+ `source: ./seed`) — named-volume references are never flagged
 */
export function findSiblingComposeRelativePaths(composeText: string): SiblingComposeRelativePath[] {
  const found: SiblingComposeRelativePath[] = [];
  const lines = composeText.split(/\r?\n/);
  let pendingListDirective: "env_file" | "volumes" | null = null;
  let pendingListIndent = -1;

  for (const line of lines) {
    // Skip full-line comments.
    const noComment = line.replace(/\s+#.*$/, "");
    const trimmed = noComment.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = noComment.length - noComment.trimStart().length;

    if (pendingListDirective !== null) {
      if (indent > pendingListIndent) {
        if (pendingListDirective === "volumes") {
          // Long form: a `source:` key nested under a `- type: bind` item.
          const sourceMatch = /^-?\s*source\s*:\s*(.*)$/.exec(trimmed);
          if (sourceMatch) {
            const val = sourceMatch[1].trim();
            if (isRelativePathValue(val)) found.push({ directive: "volume", value: stripQuotes(val) });
            continue;
          }
          // Short form: `- ./seed:/target[:ro]` (named volumes like `- dbdata:/x` skip).
          if (trimmed.startsWith("-")) {
            const item = trimmed.replace(/^-\s*/, "");
            const source = extractVolumeBindSource(item);
            if (source) found.push({ directive: "volume", value: stripQuotes(source) });
          }
          continue;
        }
        // env_file: plain list item (`- ./x`) or mapping form (`- path: ./x`, with any
        // following `required:`/other keys on their own indented line ignored).
        if (trimmed.startsWith("-")) {
          const item = trimmed.replace(/^-\s*/, "");
          const pathMatch = /^path\s*:\s*(.*)$/.exec(item);
          const rawValue = (pathMatch ? pathMatch[1] : item).trim();
          if (isRelativePathValue(rawValue)) found.push({ directive: "env_file", value: stripQuotes(rawValue) });
        }
        continue;
      }
      // Dedented out of the list — fall through to re-evaluate this line as a new key.
      pendingListDirective = null;
    }

    const inline = /^(env_file|context|file|build|dockerfile|volumes)\s*:\s*(.*)$/.exec(trimmed);
    if (!inline) continue;
    const key = inline[1];
    const rest = inline[2].trim();

    if (key === "build") {
      // `build: ./x` shorthand only; the `build:`-block `context:`/`dockerfile:` are
      // caught by their own cases on their own lines.
      if (rest.length > 0 && !rest.startsWith("#") && isRelativePathValue(rest)) {
        found.push({ directive: "context", value: stripQuotes(rest) });
      }
      continue;
    }
    if (key === "volumes") {
      // Block-list form: subsequent `- ./x` lines belong to this directive. An inline
      // value (`volumes: []`) is never a path — nothing to flag.
      if (rest.length === 0) {
        pendingListDirective = "volumes";
        pendingListIndent = indent;
      }
      continue;
    }
    if (key === "env_file" && rest.length === 0) {
      // Block-list form: subsequent `- ./x` lines belong to this directive.
      pendingListDirective = "env_file";
      pendingListIndent = indent;
      continue;
    }
    // Inline scalar (`env_file: ./x`, `context: ./x`, `file: ./x`, `dockerfile: ../x`).
    if (rest.length > 0 && isRelativePathValue(rest)) {
      found.push({ directive: key as "env_file" | "context" | "file" | "dockerfile", value: stripQuotes(rest) });
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
 * Extract `include:`/`extends: file:` file references from a compose file's text —
 * relative to the file's OWN directory (compose resolves both directives that way,
 * unlike the `-f` multi-project-directory quirk #109 targets). Pure text scan; the
 * caller resolves+reads the referenced file (one level, no further recursion).
 */
export function extractComposeFileReferences(composeText: string): string[] {
  const refs: string[] = [];
  const lines = composeText.split(/\r?\n/);
  let inIncludeList = false;
  let includeListIndent = -1;
  let inExtendsBlock = false;
  let extendsBlockIndent = -1;

  const pushRef = (raw: string) => {
    const v = stripQuotes(raw.trim());
    if (v.length > 0 && !v.includes("${")) refs.push(v);
  };

  for (const line of lines) {
    const noComment = line.replace(/\s+#.*$/, "");
    const trimmed = noComment.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = noComment.length - noComment.trimStart().length;

    if (inIncludeList) {
      if (indent > includeListIndent) {
        if (trimmed.startsWith("-")) {
          const item = trimmed.replace(/^-\s*/, "");
          const pathMatch = /^path\s*:\s*(.*)$/.exec(item);
          pushRef(pathMatch ? pathMatch[1] : item);
        } else {
          const pathMatch = /^path\s*:\s*(.*)$/.exec(trimmed);
          if (pathMatch) pushRef(pathMatch[1]);
        }
        continue;
      }
      inIncludeList = false;
    }
    if (inExtendsBlock) {
      if (indent > extendsBlockIndent) {
        const fileMatch = /^file\s*:\s*(.*)$/.exec(trimmed);
        if (fileMatch) pushRef(fileMatch[1]);
        continue;
      }
      inExtendsBlock = false;
    }

    if (/^include\s*:\s*$/.test(trimmed)) {
      inIncludeList = true;
      includeListIndent = indent;
      continue;
    }
    if (/^extends\s*:\s*$/.test(trimmed)) {
      inExtendsBlock = true;
      extendsBlockIndent = indent;
      continue;
    }
    // Inline extends: `extends: { file: ./base.yml, service: x }`
    const inlineExtends = /^extends\s*:\s*\{(.*)\}\s*$/.exec(trimmed);
    if (inlineExtends) {
      const fileMatch = /file\s*:\s*([^,}]+)/.exec(inlineExtends[1]);
      if (fileMatch) pushRef(fileMatch[1]);
    }
  }
  return [...new Set(refs)];
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
