#!/usr/bin/env node
// @board-hook-version: 5
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
 *   - ALLOW writes outside every git repository (e.g. %TEMP%, ~/.claude) — not our concern.
 *   - BLOCK writes inside any OTHER worktree of the same repo.
 *   - BLOCK writes inside any UNRELATED git checkout (#959), when the board declared the
 *     authorized root. See "Foreign checkouts" below.
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
 *
 * Match WRITE TARGETS, not mentions (#890): the old shell detection blocked any command whose
 * TEXT contained another worktree's path once a mutating verb appeared ANYWHERE — a path quoted
 * inside a heredoc body, a data string, or next to an unrelated `>` elsewhere in the command all
 * counted, and the only escape disabled the whole guard. The command is now analysed per
 * SEGMENT: heredoc bodies are stripped first (data, never commands — the write target is the
 * redirect before them), and for the shapes the guard can classify (redirect targets, cp/mv
 * destinations, tee args, `git -C <path>` + a mutating subcommand, rm/mkdir/touch/sed -i
 * targets) only the RESOLVED WRITE TARGETS — plus the segment's effective cwd, tracked across
 * `cd` — are matched against foreign worktrees. A segment that mutates in a way the guard
 * cannot classify keeps the old whole-segment mention matching: fail closed, never open.
 *
 * FOREIGN CHECKOUTS — the HARD BLOCK (#959)
 * ------------------------------------------
 * Everything above guards OTHER WORKTREES OF THE SAME REPO. A completely unrelated checkout is
 * neither the main checkout nor a linked worktree, so it was not covered at all — and a builder
 * used exactly that hole: scoped to `.worktrees/agentic-kanban/ak-954`, it edited and COMMITTED
 * into `C:\projects\andrena\test-impact-skill`, a repo not registered on the board. Another
 * session then pushed that commit to its origin believing it was its own work. Nothing on the
 * board surfaced it; it was found out of band. The diff happened to be correct, which is what
 * makes it dangerous rather than obviously bad.
 *
 * The rule is therefore a HARD BLOCK, not a warning: a builder must never WRITE outside its own
 * worktree, foreign repos included. A card needing a change in another repo must ASK for it —
 * file a ticket against that repo's project, or hand it to the session that owns it.
 *
 * Three properties keep that from being over-broad:
 *   1. It requires a board-declared root (KANBAN_WORKTREE_DIR). Without one the authorized root
 *      is DERIVED from cwd, so every hand-run session would be judged against itself; the
 *      foreign-checkout check simply does not run then. Same gating as the #472 cwd check.
 *   2. It only fires for a target inside SOME git repository. A write to %TEMP%, `~/.claude`,
 *      a package cache or any other non-repo path is untouched — those are legitimate and
 *      constant, and blocking them would wedge every agent.
 *   3. SIBLING WORKTREES OF THE SAME WORKSPACE STAY WRITABLE. A multi-repo project provisions
 *      one worktree per repo at `<parent>/.worktrees/<repoDirName>/<leaf>`, so they are peers
 *      under the same `.worktrees/` root as the authorized worktree (`worktreesDirFor` in
 *      shared/lib/git-service/worktree.ts). `isSiblingWorkspaceWorktree` recognises exactly that
 *      shape. A repo that merely sits NEXT TO the project on disk is not under `.worktrees/` and
 *      is not covered by this — which is the whole point: `test-impact-skill` was such a repo.
 *
 * Reads are untouched, as everywhere else in this guard: a builder legitimately reads sibling
 * repos and materialized skills.
 */

const path = require("path");
const readline = require("readline");
const { existsSync, statSync } = require("fs");
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

/**
 * Normalise a path for separator-insensitive (and, on Windows, case-insensitive) comparison.
 *
 * Case is folded ONLY on win32, where the filesystem is genuinely case-insensitive. That is not
 * cosmetic: `containingRepo` (#959) hits the filesystem with a normed path, and on a
 * case-SENSITIVE filesystem a blanket-lowercased path simply does not exist — every lookup would
 * walk to `/` and the foreign-checkout check would silently never fire on Linux (a fleet worker,
 * a container, any scaffolded project). Same rule, for the same reason, as
 * `shared/lib/gradle-env.ts`.
 */
const FOLD_CASE = process.platform === "win32";

function norm(p) {
  if (!p) return "";
  let r = path.resolve(p).replace(/\\/g, "/");
  // Drop a trailing slash (except root).
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return FOLD_CASE ? r.toLowerCase() : r;
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

/**
 * The git toplevel that CONTAINS `p`, or null when `p` is in no repository at all (#959).
 *
 * Two reasons this walks up rather than asking about `p` directly, and BOTH bit in testing:
 *  - `p` need not exist yet — a Write creates its file, and `git rev-parse` on a missing path
 *    fails. Creating `<foreign repo>/src/new.ts` is a write into the foreign repo whether or
 *    not `src/` exists.
 *  - `git rev-parse` needs a DIRECTORY as its cwd. A write target that already exists is a
 *    FILE, so starting at `p` itself returned null for every existing file — the guard would
 *    have allowed an edit to any file that was already there, which is most of them.
 *
 * So: find the nearest existing ancestor DIRECTORY and ask git about that.
 *
 * `p` is a `norm()`ed path, which is also a valid filesystem path — {@link norm} folds case
 * only on Windows precisely so that this function can hit the filesystem with its output.
 */
function containingRepo(p) {
  let dir = p;
  for (let i = 0; i < 64; i++) {
    if (existsSync(dir) && isDirectory(dir)) {
      const top = gitToplevel(dir);
      return top ? norm(top) : null;
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** True when `p` exists AND is a directory (a file is not a usable git cwd). */
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when `repoRoot` is a peer worktree of the SAME workspace — a multi-repo project's
 * sibling repo (#959 property 3).
 *
 * The board provisions those at `<parent>/.worktrees/<repoDirName>/<leaf>` for every repo of
 * the project, so the authorized worktree and its siblings are peers two levels under a shared
 * `.worktrees/` directory. Matching that shape keeps multi-repo builders working without a new
 * env channel, and it does NOT admit an arbitrary neighbouring checkout: a plain repo sitting
 * beside the project on disk is not under `.worktrees/` at all.
 */
function isSiblingWorkspaceWorktree(repoRoot, authorizedRootPath) {
  const marker = "/.worktrees/";
  const at = authorizedRootPath.lastIndexOf(marker);
  if (at === -1) return false;
  // `<...>/.worktrees/` — the root both the authorized worktree and its siblings live under.
  const worktreesRoot = authorizedRootPath.slice(0, at + marker.length);
  if (!repoRoot.startsWith(worktreesRoot)) return false;
  // Depth must match: `<repoDirName>/<leaf>`, i.e. exactly two segments below `.worktrees/`,
  // so a nested checkout deeper inside another worktree is not silently admitted.
  const rel = repoRoot.slice(worktreesRoot.length);
  return rel.split("/").filter(Boolean).length === 2;
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
 * Remove every heredoc BODY (the lines between `<<MARKER` and the closing MARKER line) from a
 * command (#890). A heredoc body is data — mentioning a sibling worktree there, or even quoting
 * `git commit` there, mutates nothing; the actual write target is the redirect on the intro
 * line, which is kept. A heredoc whose closing marker is missing strips to end-of-command,
 * which can only make the guard MISS a body — and the body is exactly what must not match.
 */
function stripHeredocBodies(command) {
  const lines = String(command).split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const m = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]);
    if (!m) continue;
    const marker = m[2];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== marker; j++) {
      /* body line — dropped */
    }
    if (j < lines.length) kept.push(lines[j]);
    i = j;
  }
  return kept.join("\n");
}

/** True when the (body-stripped) command carries any mutating verb at all. */
function commandMutates(command) {
  return MUTATING_PATTERNS.some((re) => re.test(stripHeredocBodies(command)));
}

/** Split a (body-stripped) shell command into the segments that run as separate commands. */
function splitShellSegments(command) {
  return String(command).split(/\n|&&|\|\||;|\|/g);
}

/** Tokenize one segment, stripping surrounding quotes. */
function segmentTokens(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const t = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    if (t !== "") tokens.push(t);
  }
  return tokens;
}

const VERB_PREFIXES = new Set(["sudo", "command", "time", "nohup", "env", "exec", "builtin", "nice"]);
const CD_VERBS = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);

/** The segment's command verb, skipping `FOO=bar` prefixes and wrappers. */
function segmentVerb(tokens) {
  for (const raw of tokens) {
    const t = raw.replace(/^[(){}!]+/, "");
    if (t === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    const verb = t.replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat|sh|ps1)$/i, "").toLowerCase();
    if (VERB_PREFIXES.has(verb)) continue;
    return verb;
  }
  return "";
}

/** Non-flag, non-assignment, non-whitespace-bearing argument tokens (candidate paths). */
function pathArgs(tokens) {
  return tokens
    .slice(1)
    .filter((t) => !t.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !/\s/.test(t));
}

/** Verbs whose ONLY writes go through a redirect — a foreign path argument to them is a read. */
const READ_ONLY_VERBS = new Set([
  "cat", "echo", "printf", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep",
  "sort", "uniq", "cut", "tr", "wc", "jq", "yq", "ls", "dir", "find", "fd", "diff", "cmp",
  "stat", "file", "type", "which", "basename", "dirname", "md5sum", "sha1sum", "sha256sum",
]);

/**
 * The write TARGETS of one mutating segment, for the shapes the guard can classify (#890).
 * Returns `{ targets, classified }`; `classified: false` means "it mutates, but WHAT it writes
 * could not be resolved" — the caller then falls back to the old whole-segment mention match
 * (fail closed).
 */
function segmentWriteTargets(segment, tokens, verb) {
  const targets = [];
  // `> out` / `>> out` redirect targets — a write whatever the verb is.
  const re = /\d?>>?\s*("[^"]+"|'[^']+'|[^\s|&;<>]+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const t = m[1].replace(/^["']|["']$/g, "");
    if (t && !t.startsWith("&") && t !== "/dev/null" && t.toLowerCase() !== "$null") targets.push(t);
  }
  if (verb === "git") {
    // `git -C <path> <mutating-sub>` writes into <path>; a plain `git <mutating>` writes into
    // the effective cwd (checked by the caller). Path-shaped args (a path remote, a pathspec)
    // stay targets so `git push /other/repo` keeps blocking — reads like `-F <msg>` outside a
    // worktree resolve to nothing foreign anyway.
    const ci = tokens.findIndex((t) => t === "-C");
    if (ci !== -1 && tokens[ci + 1]) targets.push(tokens[ci + 1]);
    for (const t of pathArgs(tokens)) {
      if (t.includes("/") || t.includes("\\") || t.includes("..")) targets.push(t);
    }
    return { targets, classified: true };
  }
  if (verb === "cp" || verb === "mv") {
    // The DESTINATION is the last path argument; the sources are reads.
    const args = pathArgs(tokens);
    if (args.length >= 2) targets.push(args[args.length - 1]);
    else targets.push(...args);
    return { targets, classified: true };
  }
  if (verb === "tee") {
    targets.push(...pathArgs(tokens));
    return { targets, classified: true };
  }
  if (["rm", "rmdir", "mkdir", "touch", "truncate", "remove-item"].includes(verb)) {
    // For these the path arguments ARE the write targets.
    targets.push(...pathArgs(tokens));
    return { targets, classified: true };
  }
  if (
    ["sed", "perl", "awk", "gawk", "ruby"].includes(verb) &&
    tokens.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place")
  ) {
    targets.push(...pathArgs(tokens).filter((t) => t.includes("/") || t.includes("\\") || t.includes(".")));
    return { targets, classified: true };
  }
  // A read verb whose only write is its redirect: the redirect targets are the complete set.
  if (verb === "" || READ_ONLY_VERBS.has(verb)) return { targets, classified: true };
  return { targets, classified: false };
}

/**
 * Decide whether a shell command reaches into another worktree in a MUTATING way.
 * Returns the offending worktree root, or null.
 *
 * #890 — per-segment write-target analysis instead of whole-command mention matching:
 *  - heredoc bodies are stripped up front (data, not commands);
 *  - `cd`/`pushd` move the effective cwd for later segments; a MUTATING segment whose
 *    effective cwd sits inside a foreign worktree is a violation whatever it names
 *    (the #369 incident shape: `cd <main>; git commit -F msg`);
 *  - for classifiable shapes only the resolved WRITE TARGETS are matched, so a foreign path
 *    that is merely read (`cp <foreign>/a ./b`, `git -C <foreign> config`, a quoted mention)
 *    no longer blocks;
 *  - a mutating segment the guard cannot classify falls back to the old behaviour — any
 *    foreign-worktree mention in THAT segment blocks. Ambiguity fails closed, never open.
 */
function shellViolation(command, currentRoot, others, cwd, execCwd, foreignRepoCheck) {
  if (!command) return null;
  if (others.length === 0 && !foreignRepoCheck) return null;
  const stripped = stripHeredocBodies(command);
  if (!MUTATING_PATTERNS.some((re) => re.test(stripped))) return null;

  const base = norm(execCwd || cwd || "");
  let effCwd = base;
  // Whether the COMMAND moved its own cwd. Only then is "mutating while standing in a foreign
  // worktree" this function's call — a foreign STARTING cwd is #472's check, which is gated on
  // the board-declared root precisely because a derived root would compare a value to itself.
  let cdChanged = false;
  const resolveTok = (t) => {
    const clean = String(t).replace(/^["']|["']$/g, "");
    if (!clean) return "";
    return norm(path.isAbsolute(clean) ? clean : path.join(effCwd || base || ".", clean));
  };
  /**
   * Classify a resolved path: a peer worktree of the same repo (`worktree`), an unrelated
   * checkout (`repo`, #959), or not a violation at all. Returns `{ kind, root }` or null.
   *
   * Worktree first, so the long-standing #369/#472 message keeps naming the worktree case; the
   * foreign-repo verdict is the new fallback, and only when the caller enabled it.
   */
  const foreignOf = (resolved) => {
    if (!resolved || isInside(resolved, currentRoot)) return null;
    const wt = others.find((w) => isInside(resolved, w));
    if (wt) return { kind: "worktree", root: wt };
    if (!foreignRepoCheck) return null;
    const repo = foreignRepoCheck(resolved);
    return repo ? { kind: "repo", root: repo } : null;
  };

  for (const segment of splitShellSegments(stripped)) {
    if (!segment.trim()) continue;
    const tokens = segmentTokens(segment);
    const verb = segmentVerb(tokens);
    if (CD_VERBS.has(verb)) {
      const target = tokens.slice(1).find((t) => !t.startsWith("-"));
      if (!target || target === "-" || target === "~") effCwd = base;
      else effCwd = norm(path.isAbsolute(target) ? target : path.join(effCwd || base || ".", target));
      cdChanged = true;
      continue;
    }
    if (!MUTATING_PATTERNS.some((re) => re.test(segment))) continue; // this segment only reads

    // Mutating after the command CD-ED into a foreign worktree — the incident shape
    // (`cd <main>; git commit -F msg`), no path in the mutating segment needed.
    const cwdForeign = cdChanged && effCwd ? foreignOf(effCwd) : null;
    if (cwdForeign) return cwdForeign;

    const { targets, classified } = segmentWriteTargets(segment, tokens, verb);
    for (const t of targets) {
      const offending = foreignOf(resolveTok(t));
      if (offending) return offending;
    }
    if (!classified) {
      // Fail closed: it mutates, we cannot tell what — any foreign mention in this segment blocks.
      const haystack = normText(segment);
      for (const other of others) {
        if (haystack.includes(other)) return { kind: "worktree", root: other };
      }
      for (const token of commandPathTokens(segment)) {
        const offending = foreignOf(resolveTok(token));
        if (offending) return offending;
      }
    }
  }
  return null;
}

/**
 * Forward-slash (and, on Windows, lowercase) a free-text command so absolute paths inside it
 * compare like `norm()` output. Must fold case on exactly the same platforms as {@link norm},
 * or the fail-closed mention match stops matching what it is compared against.
 */
function normText(text) {
  const s = String(text).replace(/\\/g, "/");
  return FOLD_CASE ? s.toLowerCase() : s;
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

/**
 * Pure-ish decision core, callable IN-PROCESS by smart-hooks-runner.js (#914) — the same
 * shape `validate-command-safety.js` and `vital-file-guard.js` expose. Returns
 * `{ decision: "allow" | "block", reason?, stderr: string[] }`; `main()` below is the
 * unchanged CLI wrapper, so this file still works standalone for Codex/Pi.
 *
 * The guard's own fail-open-but-say-so contract is unchanged: an uninspectable input is
 * still allowed WITH the stable `[cross-worktree-guard] ALLOWED WITHOUT CHECKING` marker
 * on stderr (#391), because wedging an agent on a parse error is worse than a logged gap.
 * Fail-CLOSED for a guard that THREW is the caller's job: the runner falls back to
 * spawning the script rather than treating an exception as a pass.
 */
function evaluateToolCall(input) {
  const stderr = [];
  const allowV = () => ({ decision: "allow", stderr });
  const blockV = (reason) => ({ decision: "block", reason, stderr });

  if (!input) {
    // #391: this is a silent no-guard state — during #369's own verification two bypass replays
    // reported exit 0 and were nearly recorded as "not blocked", when the real cause was
    // malformed JSON hitting exactly this path. Fail open (never wedge an agent on a parse
    // error) but SAY SO, with a stable marker the board can grep for.
    stderr.push(
      "[cross-worktree-guard] ALLOWED WITHOUT CHECKING: stdin was empty or not valid JSON, " +
      "so the tool call could not be inspected. This is a no-guard state, not a pass."
    );
    return allowV();
  }

  const toolName = input.tool_name || input.toolName;
  const isShell = SHELL_TOOLS.has(toolName);
  if (!WRITE_TOOLS.has(toolName) && !isShell) return allowV();

  const toolInput = input.tool_input || input.toolInput;
  const command = isShell ? (toolInput && (toolInput.command || toolInput.script)) || "" : "";
  const targets = isShell ? [] : targetPaths(toolName, toolInput);
  if (!isShell && targets.length === 0) return allowV();
  if (isShell && !command) return allowV();

  // Checked HERE, not before reading the input, so the inline form on the command can be
  // seen (#408).
  if (overrideActive(command)) return allowV();

  // The worktree this instance is AUTHORIZED to operate in — board-declared where possible.
  const { root: currentRoot, source: rootSource, cwd } = authorizedRoot(input.cwd);
  const worktrees = listWorktrees(cwd).map(norm);

  /**
   * The FOREIGN-CHECKOUT classifier (#959), or null when this check must not run.
   *
   * Only armed for a board-declared root: without KANBAN_WORKTREE_DIR the authorized root is
   * derived from the process's own cwd, so a hand-run session would be judged against itself
   * and every ordinary write outside its repo would block. Same gate as the #472 cwd check.
   *
   * Returns the offending repo root for a path that lies in SOME git repository which is
   * neither the authorized worktree nor a sibling worktree of this workspace; null otherwise
   * (including every path in no repository at all — %TEMP%, ~/.claude, caches).
   *
   * Takes a `norm()`ed path, which is also a usable filesystem path — see {@link norm}.
   */
  const foreignRepoCheck =
    rootSource === "KANBAN_WORKTREE_DIR"
      ? (target) => {
          if (!target || isInside(target, currentRoot)) return null;
          const repo = containingRepo(target);
          if (!repo) return null; // not in any repository → not our concern, as before
          if (repo === currentRoot) return null;
          if (isSiblingWorkspaceWorktree(repo, currentRoot)) return null;
          return repo;
        }
      : null;

  if (worktrees.length <= 1 && !foreignRepoCheck) {
    // Inside a builder container this is usually because only ONE worktree's git dir is
    // mounted (no visibility into siblings/main), so the guard degrades to a no-op — the
    // container's own mount boundary is the actual protection in that case. Silently
    // checking nothing is not acceptable for this guard (#158), so say so loudly instead of
    // letting the degrade look identical to "genuinely nothing to protect".
    if (process.env.AGENTIC_KANBAN_CONTAINER === "1") {
      stderr.push(
        "[cross-worktree-guard] containerized session: `git worktree list` sees only this " +
          "worktree — the guard cannot detect siblings and is relying on the container's own " +
          "mount isolation instead."
      );
    }
    return allowV(); // single-worktree repo or not a repo → nothing to protect
  }

  const others = worktrees.filter((w) => w !== currentRoot);

  /** The refusal text for a write into an unrelated checkout (#959). */
  const foreignRepoBlock = (target, repo, what) =>
    blockV(
      `⛔ Write into an UNRELATED git checkout blocked (${what}).\n\n` +
        `This session is authorized for (via ${rootSource}):\n  ${currentRoot}\n\n` +
        `but it targets a DIFFERENT repository:\n  ${target}\n  (repo: ${repo})\n\n` +
        "A builder must never write outside its own worktree — foreign repos included. This is\n" +
        "the #959 vector: a builder scoped to one ticket edited and COMMITTED into an unrelated\n" +
        "checkout, and the session that owned that repo pushed the commit to its origin believing\n" +
        "it was its own work. Nothing on the board surfaced it.\n\n" +
        "If this change really belongs in that repo, ASK for it instead of making it:\n" +
        "  • file a ticket against that repo's project on the board, or\n" +
        "  • hand it to the session that owns that checkout.\n\n" +
        "Reading that repo is still fine — only writes are refused. Do NOT bypass by editing\n" +
        "this hook."
    );

  // #472 — the cwd ITSELF can be the violation, and nothing was checking it.
  //
  // MEASURED: a background subagent launched for a ticket in `.worktrees/ak-111` committed to the
  // SHARED `eventhub-backend` checkout on master (`fe83a33`), and a later unrelated merge carried
  // that stray commit forward. The guard was fully wired in that project and still allowed it —
  // because `shellViolation` only inspects PATH TOKENS IN THE COMMAND, and a bare
  // `git commit -am "…"` names no path. The guard was implicitly trusting that the process's cwd
  // WAS the authorized worktree.
  //
  // `KANBAN_WORKTREE_DIR` is set by the board when it launches the agent and cannot be moved by
  // cd-ing anywhere (#369 gap ii), so where it is present it is authoritative about which worktree
  // this session belongs to — and a command running somewhere else is a violation whatever it
  // says. Applied ONLY when the board declared the root: without it the root is DERIVED from cwd,
  // so comparing the two would be comparing a value to itself.
  //
  // Containment, not equality: running in `<worktree>/packages/server` is normal.
  //
  // `input.cwd`, NOT the destructured `cwd`: when the board declared the root, `authorizedRoot`
  // returns the DECLARED path as its cwd, so comparing that would compare a value to itself and
  // never fire (it did not, on the first attempt at this fix).
  // Gated on MUTATION, so the guard keeps its standing promise that reading another worktree is
  // fine — an inspection command run from over there is odd, not dangerous, and blocking it would
  // be a new restriction rather than a fix.
  // SHELL only, and only for a MUTATING command. A structured Write/Edit always names its target,
  // so the per-target loop below already judges it correctly — extending this check to those
  // blocked a write into the CORRECT worktree issued from a session whose cwd was elsewhere,
  // which is legitimate and is asserted by cross-worktree-guard.test.ts. And reads stay allowed:
  // an inspection command run from another worktree is odd, not dangerous.
  // `commandMutates` strips heredoc bodies first (#890): a mutating verb quoted inside a
  // heredoc's DATA must not arm this check any more than it arms the segment analysis below.
  if (rootSource === "KANBAN_WORKTREE_DIR" && input.cwd && isShell && commandMutates(command)) {
    const here = norm(gitToplevel(input.cwd) || input.cwd);
    const outside = !isInside(norm(input.cwd), currentRoot);
    // #959: the same "the cwd IS the violation" shape, one repo further out — a bare
    // `git commit -am ...` issued while standing in an unrelated checkout names no path
    // either, and `others` (worktrees of THIS repo) does not contain it.
    if (outside && !others.includes(here) && foreignRepoCheck) {
      const repo = foreignRepoCheck(norm(input.cwd));
      if (repo) return foreignRepoBlock(norm(input.cwd), repo, "wrong working directory");
    }
    if (outside && others.includes(here)) {
      return blockV(
        "⛔ Cross-worktree command blocked — WRONG WORKING DIRECTORY.\n\n" +
          `This session is authorized for (via KANBAN_WORKTREE_DIR):\n  ${currentRoot}\n\n` +
          `but it is running in a DIFFERENT git worktree:\n  ${here}\n\n` +
          "This is the #472 vector: the command names no path at all (`git commit -am ...`), so\n" +
          "there is nothing for a path check to catch — the working directory is the whole\n" +
          "violation. A background subagent that starts in, or is moved to, another checkout\n" +
          "commits there without ever mentioning it, bypassing the ticket's branch/merge gate.\n\n" +
          "Fix: run the command from your own worktree above. If you genuinely need to operate\n" +
          "in another worktree, prefix THIS command with the override:\n" +
          "  ALLOW_CROSS_WORKTREE_WRITE=1 <your command>\n" +
          "Do NOT bypass by editing this hook."
      );
    }
  }

  if (isShell) {
    // `input.cwd` (where the command actually runs) anchors relative paths and the effective-cwd
    // tracking; the authorized root's cwd is the fallback for harnesses that send none.
    const offending = shellViolation(command, currentRoot, others, cwd, input.cwd, foreignRepoCheck);
    if (offending && offending.kind === "repo") {
      // #959 — an unrelated checkout, e.g. `git -C <foreign repo> commit`.
      return foreignRepoBlock(offending.root, offending.root, "shell command");
    }
    if (offending) {
      return blockV(
        "⛔ Cross-worktree shell command blocked.\n\n" +
          `This session is authorized for (via ${rootSource}):\n  ${currentRoot}\n\n` +
          `but the command mutates a DIFFERENT git worktree:\n  ${offending.root}\n\n` +
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
    return allowV();
  }

  for (const target of targets) {
    const t = norm(path.isAbsolute(target) ? target : path.join(cwd, target));
    // Writing inside our own worktree is always fine.
    if (isInside(t, currentRoot)) continue;
    // Writing inside a different worktree is the violation we guard against.
    const offending = others.find((w) => isInside(t, w));
    if (offending) {
      return blockV(
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
    // #959 — not a worktree of this repo, but possibly an UNRELATED checkout. This is the
    // Write/Edit door of the same hole: the incident's shell commit was preceded by tool edits
    // to the foreign repo's files, and neither was covered.
    if (foreignRepoCheck) {
      const repo = foreignRepoCheck(t);
      if (repo) return foreignRepoBlock(t, repo, "file write");
    }
    // Target is outside every git repository (temp, home, caches) → not our concern.
  }

  return allowV();
}

async function main() {
  const verdict = evaluateToolCall(await readInput());
  for (const line of verdict.stderr) console.error(line);
  if (verdict.decision === "block") block(verdict.reason);
  allow();
}

module.exports = { evaluateToolCall };

// Only run the CLI wrapper when spawned as a process. When smart-hooks-runner.js
// require()s this file for the in-process fast path, `main()` must NOT execute.
if (require.main === module) main().catch(() => process.exit(0));
