#!/usr/bin/env node
// Stop hook: check for committed git conflict markers in tracked source files.
//
// Scans packages/**/*.{ts,tsx,sql} in the current HEAD commit for lines
// matching ^(<<<<<<<|=======|>>>>>>>) — the three unresolved-merge markers.
// Only committed content is checked (via `git grep`), so working-tree edits
// and staged-but-not-committed changes are not flagged.
//
// Fires on both Claude (via direct Stop hook wiring) and Codex (via
// .codex/hooks.json direct Stop entry — matching the check-uncommitted pattern).
// On re-prompt (stop_hook_active=true) we let it through to avoid infinite loops.

const { execFileSync } = require("child_process");
const readline = require("readline");

// Regex for committed conflict marker lines.  The three markers are distinct:
//   <<<<<<< (start of "ours" block)
//   ======= (separator between ours / theirs)
//   >>>>>>> (end of "theirs" block)
// We anchor to start-of-line (git grep returns the full line).
const MARKER_RE = /^(<{7}|={7}|>{7})/;

function getProjectDir() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
}

// Run `git grep` against HEAD for conflict markers in source files.
// Returns an array of { file, line, content } matches, or [] on clean/error.
function findCommittedMarkers(repoRoot) {
  // git grep -n HEAD -- 'packages/**/*.ts' 'packages/**/*.tsx' 'packages/**/*.sql'
  // Exits 0 when matches found, 1 when no matches, 128+ on error.
  try {
    const output = execFileSync(
      "git",
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
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    const findings = [];
    for (const raw of output.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      // git grep format with HEAD ref: HEAD:path/to/file:linenum:content
      const m = raw.match(/^HEAD:(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineStr, content] = m;
      if (MARKER_RE.test(content.trimStart())) {
        findings.push({ file, line: parseInt(lineStr, 10), content: content.trimEnd() });
      }
    }
    return findings;
  } catch (err) {
    // exit code 1 = no matches (clean), ≥128 = git error — both are non-fatal
    if (err.status === 1) return []; // no matches
    return []; // git error — skip rather than false-block
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {}

  // Loop safety: don't re-block on re-prompt (matches check-uncommitted pattern).
  if (input.stop_hook_active === true) process.exit(0);

  const repoRoot = getProjectDir();
  const findings = findCommittedMarkers(repoRoot);

  if (findings.length === 0) process.exit(0);

  const fileList = [];
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.file}:${f.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      fileList.push(`  ${f.file}:${f.line}  ${f.content}`);
    }
  }

  const reason = [
    "[fatal] Committed conflict markers detected in tracked source files.",
    "",
    "The following lines contain unresolved git merge markers:",
    ...fileList,
    "",
    "Resolve the markers (keep the correct version, remove the <<<<<<<, =======,",
    "and >>>>>>> lines) and commit the fix before stopping.",
  ].join("\n");

  console.error(reason);
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(1);
}

main().catch(() => process.exit(0));
