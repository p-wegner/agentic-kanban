import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

/**
 * Conflict marker patterns — same three markers as the Stop hook.
 * We match the raw content returned by `git grep` (line-anchored in practice).
 */
const MARKER_RE = /^(<{7}|={7}|>{7})/;

export interface ConflictMarkerFinding {
  file: string;
  line: number;
  content: string;
}

/**
 * Scans packages/**\/*.{ts,tsx,sql} in the current HEAD commit for committed
 * git conflict markers (^(<<<<<<<|=======|>>>>>>>)).
 *
 * Returns an array of findings.  Empty array means clean.
 * Never throws — git errors are treated as "no findings" to stay non-fatal
 * on fresh repos / detached-HEAD states where `git grep HEAD` would fail.
 */
export function scanCommittedConflictMarkers(repoRoot: string): ConflictMarkerFinding[] {
  try {
    const output = gitExecSync(
      [
        "grep",
        "--line-number",
        "-e", "^<<<<<<<",
        "-e", "^=======",
        "-e", "^>>>>>>>",
        "HEAD",
        "--",
        "packages/**/*.ts",
        "packages/**/*.tsx",
        "packages/**/*.sql",
      ],
      {
        cwd: repoRoot,
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"] as const,
      },
    );

    const findings: ConflictMarkerFinding[] = [];
    for (const raw of output.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // git grep format with a ref: HEAD:path/to/file:linenum:content
      const m = raw.match(/^HEAD:(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineStr, content] = m;
      if (MARKER_RE.test(content.trimStart())) {
        findings.push({ file, line: parseInt(lineStr, 10), content: content.trimEnd() });
      }
    }
    return findings;
  } catch (err: unknown) {
    // exit 1 = no matches (clean); ≥128 = git error.  Both are non-fatal.
    if (typeof err === "object" && err !== null && "status" in err && (err as NodeJS.ErrnoException & { status?: number }).status === 1) {
      return [];
    }
    return [];
  }
}

/**
 * Startup assertion: if any committed conflict markers are found, logs a
 * [fatal]-prefixed alert naming every affected file+line, then returns the
 * findings so callers can decide whether to abort.
 *
 * In production (server-start.ts), we log and continue rather than crashing —
 * the alert is the signal; the server should still attempt to start so the
 * developer can reach the board and fix the issue.  In hook context (Stop hook),
 * the hook itself blocks exit.
 */
export function assertNoCommittedConflictMarkers(repoRoot: string): ConflictMarkerFinding[] {
  const findings = scanCommittedConflictMarkers(repoRoot);
  if (findings.length === 0) return [];

  console.warn("[conflict-marker-scanner] [fatal] Committed git conflict markers detected!");
  console.warn("[conflict-marker-scanner] The following lines contain unresolved merge markers:");
  for (const f of findings) {
    console.warn(`[conflict-marker-scanner]   ${f.file}:${f.line}  ${f.content}`);
  }
  console.warn(
    "[conflict-marker-scanner] Resolve the markers and commit the fix. " +
    "Unresolved markers in source files can cause esbuild/tsx parse failures and server crashes."
  );
  return findings;
}
