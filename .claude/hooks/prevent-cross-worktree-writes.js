#!/usr/bin/env node
/**
 * Prevent cross-worktree writes — keep each Claude Code instance inside its own
 * git worktree.
 *
 * Runs as a PreToolUse hook on structured file-writing tools (Write, Edit,
 * MultiEdit, NotebookEdit), Codex patch tools, AND shell tools (Bash/PowerShell/
 * Codex shell). It blocks any write — structured or shelled-out — whose target
 * lives inside a *different* git worktree of the same repo than the one this
 * instance is authorized for.
 *
 * Why: agents are launched in a dedicated worktree (cwd = worktree). When an
 * agent writes into the main checkout or a sibling worktree, that work lands
 * uncommitted in someone else's tree, blocks merges, and has corrupted the dev
 * DB (see issue #43 / docs/learnings/2026-05-27-...). This hook enforces the
 * invariant "stay in your own worktree".
 *
 * Scope / behaviour:
 *   - ALLOW writes inside the authorized worktree.
 *   - ALLOW writes outside every worktree (e.g. %TEMP%, ~/.claude) — not our concern.
 *   - BLOCK writes inside any OTHER worktree of the same repo.
 *   - BLOCK a shell command (Bash/PowerShell/Codex shell) that both references another
 *     worktree of the same repo AND carries a mutating verb (`git commit`, a `>` redirect,
 *     `Set-Content`, `rm`, …). Read-only inspection of a sibling worktree stays allowed.
 *   - No-op when cwd isn't a git repo or the repo has a single worktree.
 *
 * The two gaps this closes (#369) — both were real, and the incident used the first:
 *   (i)  Shell writes used to be UNCOVERED: only the structured write tools were guarded,
 *        so `cd <other-worktree>; git commit -F msg` walked straight past. SHELL_TOOLS +
 *        `shellViolation()` below cover that vector now.
 *   (ii) The authorized worktree used to be derived from the PROCESS'S OWN cwd, i.e. the
 *        guard self-authorized: an agent sitting in the wrong repo declared that repo
 *        authorized. `authorizedRoot()` now prefers KANBAN_WORKTREE_DIR — injected by the
 *        board at agent launch and therefore NOT under the agent's control — and only
 *        falls back to CLAUDE_PROJECT_DIR/cwd when no board-supplied root exists.
 *
 * Override (#408): prefix the shell command itself —
 *   ALLOW_CROSS_WORKTREE_WRITE=1 <your command>
 * The env-var form only works when it is in the environment this hook is SPAWNED with (the
 * session's), because the hook is its own process: `VAR=1 cmd` sets it for `cmd`, not for the
 * guard that inspects `cmd`. Write/Edit calls carry no command, so only the session-env form
 * applies to them.
 */

const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "apply_patch",
  "apply_patch_freeform",
  "functions.apply_patch",
]);
const PATCH_TOOLS = new Set(["apply_patch", "apply_patch_freeform", "functions.apply_patch"]);

/** Shell-ish tools across Claude Code and Codex, whose payload is a raw command string. */
const SHELL_TOOLS = new Set([
  "Bash",
  "PowerShell",
  "shell",
  "shell_command",
  "exec_command",
  "command_execution",
]);

/**
 * Verbs that MUTATE something. A shell command is only blocked when it both reaches into a
 * sibling worktree AND matches one of these — so `cd <other>; git log` (read-only triage,
 * which agents legitimately do) is still allowed, while `cd <other>; git commit` is not.
 *
 * Deliberately includes the git verbs that move refs/index, not just `commit`: the incident
 * commit was produced by `git commit -F`, but `git add`/`apply`/`reset`/`checkout` in another
 * worktree are the same class of damage.
 */
const MUTATING_PATTERNS = [
  // git verbs that write objects, refs, the index, or the working tree
  /\bgit\b[^\n;|&]*\b(commit|add|apply|am|cherry-pick|revert|reset|checkout|switch|restore|merge|rebase|stash|clean|rm|mv|push|tag|worktree|update-ref|gc|prune)\b/i,
  // POSIX-ish file mutation
  /(^|[\s;|&(])(cp|mv|rm|rmdir|mkdir|touch|tee|dd|truncate|install|ln|chmod|chown)\s/,
  /\bsed\s+(-[^\s]*\s+)*-i\b/,
  // shell output redirection into a file
  />>?\s*[^\s|&;]/,
  // PowerShell file mutation cmdlets
  /\b(Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Copy-Item|Move-Item|Clear-Content|Rename-Item|Set-ItemProperty|Write-File)\b/i,
];

/** Normalise a path for case-insensitive, separator-insensitive comparison (Windows-friendly). */
function norm(p) {
  if (!p) return "";
  let r = path.resolve(p).replace(/\\/g, "/");
  // Drop a trailing slash (except root) and lowercase (Windows FS is case-insensitive).
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r.toLowerCase();
}

/** True if `child` is inside (or equal to) `parent`, on a path boundary. */
function isInside(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  return child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

function gitToplevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/** List all worktree root paths for the repo containing `cwd`. */
function listWorktrees(cwd) {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Extract the target file path(s) from a write-tool input. */
function targetPaths(toolName, toolInput) {
  if (!toolInput) return [];
  if (PATCH_TOOLS.has(toolName)) {
    return patchTargetPaths(toolInput.patch || toolInput.input || toolInput.text || toolInput);
  }
  const p =
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.notebook_path ||
    toolInput.notebookPath ||
    toolInput.path;
  return p ? [p] : [];
}

function patchTargetPaths(input) {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s+(.+?)\s*$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

/**
 * The worktree this instance is AUTHORIZED to write in.
 *
 * Order matters (#369 gap ii): KANBAN_WORKTREE_DIR is set by the board when it launches the
 * agent, so it is external to the agent and cannot be moved by cd-ing somewhere else. Only
 * when it is absent (a hand-run session, another harness) do we fall back to the process's
 * own view — which is the self-authorizing behaviour we no longer rely on.
 */
function authorizedRoot(inputCwd) {
  const declared = process.env.KANBAN_WORKTREE_DIR;
  if (declared && declared.trim()) {
    return { root: norm(gitToplevel(declared) || declared), source: "KANBAN_WORKTREE_DIR", cwd: declared };
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || inputCwd || process.cwd();
  return { root: norm(gitToplevel(cwd) || cwd), source: "cwd", cwd };
}

/** Split a shell command into candidate path-ish tokens (quotes stripped). */
function commandPathTokens(command) {
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|([^\s;|&()]+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] || m[2] || m[3];
    if (raw && (raw.includes("/") || raw.includes("\\") || raw.includes(".."))) tokens.push(raw);
  }
  return tokens;
}

/**
 * Decide whether a shell command reaches into another worktree in a MUTATING way.
 * Returns the offending worktree root, or null.
 *
 * Two independent detections, because agents write paths both ways:
 *  - a raw substring hit on another worktree's absolute path (covers `cd C:\...\other-repo`,
 *    `git -C C:/…/other-repo commit`, a redirect into an absolute path), and
 *  - a relative token (`../../other-repo/x`) resolved against the authorized root.
 */
function shellViolation(command, currentRoot, others, cwd) {
  if (!command || others.length === 0) return null;
  if (!MUTATING_PATTERNS.some((re) => re.test(command))) return null;

  const haystack = normText(command);
  for (const other of others) {
    if (haystack.includes(other)) return other;
  }
  for (const token of commandPathTokens(command)) {
    const resolved = norm(path.isAbsolute(token) ? token : path.join(cwd, token));
    if (isInside(resolved, currentRoot)) continue;
    const offending = others.find((w) => isInside(resolved, w));
    if (offending) return offending;
  }
  return null;
}

/** Lowercase + forward-slash a free-text command so absolute paths compare like norm() output. */
function normText(text) {
  return String(text).replace(/\\/g, "/").toLowerCase();
}

async function readInput() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  try {
    return JSON.parse(lines.join(""));
  } catch {
    return null;
  }
}

function allow() {
  process.exit(0);
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(2);
}

/**
 * Is the documented override in force? (#408)
 *
 * `process.env` alone was wrong for every form an agent can actually use. The hook runs as its
 * OWN process, spawned by the harness with the SESSION's environment — so an agent writing
 * `ALLOW_CROSS_WORKTREE_WRITE=1 pnpm install …` sets the variable for the child command, never
 * for this guard, and the documented escape hatch silently did nothing. The message said "set
 * ALLOW_CROSS_WORKTREE_WRITE=1 for that one call" and there was no call for which that worked.
 *
 * So the inline prefix on the COMMAND ITSELF is now honoured for shell tools, which is the one
 * form an agent can express per-call. The session-env form still works for a human who exports it
 * before launching. Write/Edit tools carry no command string, so for those the session env
 * remains the only channel — said plainly in their message rather than implied.
 */
function overrideActive(command) {
  if (process.env.ALLOW_CROSS_WORKTREE_WRITE === "1") return true;
  if (typeof command !== "string") return false;
  // `VAR=1 cmd`, `export VAR=1 && cmd`, `set VAR=1` — anchored at the start of the command or of
  // a segment, so a mention inside an argument (e.g. echoing this very message) does not disarm
  // the guard.
  return /(^|[;&|]\s*)(export\s+|set\s+)?ALLOW_CROSS_WORKTREE_WRITE=(1|true)\b/i.test(command);
}

async function main() {
  const input = await readInput();
  if (!input) {
    // #391: this is a silent no-guard state — during #369's own verification two bypass replays
    // reported exit 0 and were nearly recorded as "not blocked", when the real cause was
    // malformed JSON hitting exactly this path. Fail open (never wedge an agent on a parse
    // error) but SAY SO, with a stable marker the board can grep for.
    console.error(
      "[cross-worktree-guard] ALLOWED WITHOUT CHECKING: stdin was empty or not valid JSON, " +
      "so the tool call could not be inspected. This is a no-guard state, not a pass."
    );
    allow();
  }

  const toolName = input.tool_name || input.toolName;
  const isShell = SHELL_TOOLS.has(toolName);
  if (!WRITE_TOOLS.has(toolName) && !isShell) allow();

  const toolInput = input.tool_input || input.toolInput;
  const command = isShell ? (toolInput && (toolInput.command || toolInput.script)) || "" : "";
  const targets = isShell ? [] : targetPaths(toolName, toolInput);
  if (!isShell && targets.length === 0) allow();
  if (isShell && !command) allow();

  // Checked HERE, not before readInput(), so the inline form on the command can be seen (#408).
  if (overrideActive(command)) allow();

  // The worktree this instance is AUTHORIZED to operate in — board-declared where possible.
  const { root: currentRoot, source: rootSource, cwd } = authorizedRoot(input.cwd);
  const worktrees = listWorktrees(cwd).map(norm);
  if (worktrees.length <= 1) {
    // Inside a builder container this is usually because only ONE worktree's git dir is
    // mounted (no visibility into siblings/main), so the guard degrades to a no-op — the
    // container's own mount boundary is the actual protection in that case. Silently
    // checking nothing is not acceptable for this guard (#158), so say so loudly instead of
    // letting the degrade look identical to "genuinely nothing to protect".
    if (process.env.AGENTIC_KANBAN_CONTAINER === "1") {
      console.error(
        "[cross-worktree-guard] containerized session: `git worktree list` sees only this " +
          "worktree — the guard cannot detect siblings and is relying on the container's own " +
          "mount isolation instead."
      );
    }
    allow(); // single-worktree repo or not a repo → nothing to protect
  }

  const others = worktrees.filter((w) => w !== currentRoot);

  if (isShell) {
    const offending = shellViolation(command, currentRoot, others, cwd);
    if (offending) {
      block(
        "⛔ Cross-worktree shell command blocked.\n\n" +
          `This session is authorized for (via ${rootSource}):\n  ${currentRoot}\n\n` +
          `but the command mutates a DIFFERENT git worktree:\n  ${offending}\n\n` +
          `Command:\n  ${String(command).split(/\r?\n/).slice(0, 6).join("\n  ")}\n\n` +
          "This is the #369 vector: an agent cd-ing into the main checkout (or a sibling\n" +
          "worktree) and committing there bypasses the ticket's branch/merge gate entirely.\n" +
          "Reading another worktree is fine; mutating it is not.\n\n" +
          "Fix: do the work in your own worktree above and commit there. If you genuinely\n" +
          "need to mutate another worktree, prefix THIS command with the override:\n" +
          "  ALLOW_CROSS_WORKTREE_WRITE=1 <your command>\n" +
          "(the prefix must be on the command itself — this guard runs as its own process, so\n" +
          "an env var exported elsewhere in the session does not reach it). Do NOT bypass by\n" +
          "editing this hook."
      );
    }
    allow();
  }

  for (const target of targets) {
    const t = norm(path.isAbsolute(target) ? target : path.join(cwd, target));
    // Writing inside our own worktree is always fine.
    if (isInside(t, currentRoot)) continue;
    // Writing inside a different worktree is the violation we guard against.
    const offending = others.find((w) => isInside(t, w));
    if (offending) {
      block(
        "⛔ Cross-worktree write blocked.\n\n" +
          `This Claude instance is authorized for (via ${rootSource}):\n  ${currentRoot}\n\n` +
          `but the write targets a DIFFERENT git worktree:\n  ${t}\n  (worktree: ${offending})\n\n` +
          "Each agent must stay inside its own worktree. Writing into another worktree\n" +
          "(or the main checkout) leaves work uncommitted in someone else's tree, blocks\n" +
          "merges, and has corrupted the dev DB (see issue #43).\n\n" +
          "Fix: write to a path inside your own worktree above, or edit it from an instance\n" +
          "running there. A Write/Edit call carries no command string, so the per-call override\n" +
          "does NOT apply here — the only channel is ALLOW_CROSS_WORKTREE_WRITE=1 in the\n" +
          "environment this guard is spawned with (i.e. exported before the session starts).\n" +
          "To do it in-session, run the edit as a shell command and prefix THAT with the\n" +
          "override. Do NOT bypass by editing this hook."
      );
    }
    // Target is outside every worktree (temp, home, etc.) → not our concern.
  }

  allow();
}

main().catch(() => process.exit(0));
