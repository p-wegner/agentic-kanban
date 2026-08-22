#!/usr/bin/env node
// Check for uncommitted changes when a session stops.
//
// Two cases, split by whether the stopping session owns a tracked workspace:
//
//  1. Tracked agent session (session_id maps to an active workspace):
//     check THAT workspace's worktree for any uncommitted changes.
//
//  2. Non-workspace session (interactive user, butler, or a manually-launched
//     orchestrator/monitor session — i.e. anything operating in the MAIN
//     checkout): check the MAIN checkout for uncommitted *tracked source*
//     changes. This catches the failure mode where a long-running session
//     fixes code in the main checkout but never commits it — the fixes get
//     stranded, block auto-merge, and can be lost (the codex-monitor incident).
//     Scoped to tracked packages/**/*.{ts,tsx,sql} so untracked screenshots,
//     docs, and lock-file churn don't trip it.

const { execFileSync } = require("child_process");
const { resolve } = require("path");
const { existsSync, readFileSync, readdirSync, statSync } = require("fs");
const readline = require("readline");

// `node:sqlite` needs `--experimental-sqlite` on most Node 22.x builds, and a builder
// container's Node install may not carry that flag / the module at all. A top-level
// `require` throw here would crash the whole hook before any of the try/catch logic
// below could help, so guard it — degrade to "can't look up the workspace" (falls through
// to the git-porcelain-only main-checkout check, which stays toolchain-agnostic) with a
// loud, visible notice instead of a silent stop-hook-error (#158).
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.error(
    "[check-uncommitted] node:sqlite unavailable — skipping workspace-DB lookup " +
      "(falling back to the main-checkout git check only)."
  );
}

// packages/**/*.{ts,tsx,sql} — the source/migration files whose stranding
// actually breaks builds, blocks merges, or silently loses fixes.
const SOURCE_RE = /^packages\/.+\.(ts|tsx|sql)$/;

// This hook only ever READS git state (`status`, `diff`) — it never runs `git add`, and must
// never touch the shared index. `stdio[2]: "ignore"` is not cosmetic: `execFileSync` inherits
// stderr to the parent by default, so git's per-file eol advice ("LF will be replaced by CRLF the
// next time Git touches it") printed ~28 lines ahead of the hook's actual finding and buried it —
// and read as if the hook were staging files.
const GIT_READ_STDIO = ["ignore", "pipe", "ignore"];

function gitPorcelain(cwd) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: GIT_READ_STDIO,
    });
  } catch {
    return "";
  }
}

/** One `git` invocation whose stdout we want, or `null` when git could not answer at all. */
function gitOut(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      stdio: GIT_READ_STDIO,
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// #770 — a dirty path must differ in CONTENT, not merely in stat metadata.
//
// Observed: the hook called `packages/server/src/worker/worker-repo.ts` STRANDED and told the
// session to commit it, while the worktree blob and the index blob were byte-identical
// (`ebe8e79f…` both sides) and `git diff` for the path was empty — `git add` staged nothing.
// The instruction was to make an empty commit, in the same breath as the legitimate warning
// that stranded fixes block auto-merge. A guard whose instruction is sometimes vacuous gets
// read as noise, and then the real warning is ignored too — and "make it go away" in a shared
// checkout means `git add`-ing a wider pathspec, which is how another agent's staged work gets
// swept into the wrong commit.
//
// `git status --porcelain` answers "does the index entry differ from the worktree entry (or
// HEAD)", which a stale stat entry, a mode flip or a type change can satisfy with identical
// bytes. `git diff --name-status HEAD` (worktree vs HEAD) and `git diff --cached --name-status
// HEAD` (index vs HEAD) are TREE comparisons: a path whose content equals HEAD's cannot appear
// in either, whatever its mtime says. Their union is therefore exactly "content that a commit
// would actually change" — including a change staged and then reverted in the worktree, which
// worktree-vs-HEAD alone would miss.
// ---------------------------------------------------------------------------

/**
 * Parse `git diff --name-status -z` output into edited/deleted source paths.
 *
 * NUL-separated fields: `<status>\0<path>\0`, and `R<score>\0<old>\0<new>\0` for a rename/copy
 * (we keep the NEW path as an edit, matching the porcelain parser's `->` handling, so a
 * rename-heavy branch is not mistaken for the deletion-dominant desync below).
 */
function parseNameStatusZ(raw, edited, deleted) {
  const fields = String(raw || "").split("\0").filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    const code = status[0];
    let p = fields[i++];
    if (code === "R" || code === "C") p = fields[i++];
    if (p === undefined) break;
    const norm = p.replace(/\\/g, "/");
    if (!SOURCE_RE.test(norm)) continue;
    if (code === "D") deleted.push(norm);
    else edited.push(norm);
  }
}

/** The porcelain (stat-cache-trusting) classifier — kept only as the fallback when git cannot diff. */
function porcelainSourceChanges(cwd) {
  const edited = [];
  const deleted = [];
  for (const line of gitPorcelain(cwd).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    if (xy === "??") continue; // untracked — ignore
    let p = line.slice(3).trim();
    if (p.includes(" -> ")) p = p.split(" -> ")[1].trim(); // rename
    p = p.replace(/\\/g, "/").replace(/^"|"$/g, "");
    if (!SOURCE_RE.test(p)) continue;
    // Porcelain status: a deletion is `D` in either the staged (X) or unstaged (Y)
    // column (" D", "D ", "AD", etc.). Anything else is an edit/add/rename target.
    if (xy.includes("D")) deleted.push(p);
    else edited.push(p);
  }
  return { edited, deleted, all: [...edited, ...deleted] };
}

// Tracked (not "??") CONTENT changes to source files, classified by whether each is a
// DELETION (file removed from the working tree) or an EDIT/ADD. A working tree
// that is dominated by deletions is a desync to RESTORE, never a set of changes
// to commit (#771): a board merge whose working-tree sync regressed can leave
// 100+ tracked source files showing as `D` while HEAD still contains them.
// Committing them would DELETE packages/shared from the branch — so the hook must
// tell the agent to investigate/restore, not "commit before stopping".
//
// `run` is injectable so the content-vs-stat-cache behaviour can be unit-tested without
// manufacturing a stale index (#770).
function trackedSourceChanges(cwd, run = (args) => gitOut(cwd, args)) {
  const worktree = run(["diff", "--name-status", "-z", "HEAD"]);
  const staged = run(["diff", "--cached", "--name-status", "-z", "HEAD"]);
  if (worktree === null && staged === null) {
    // No HEAD (fresh repo — nothing is tracked, so this is empty anyway) or git is unusable.
    // Degrade to the old stat-cache answer rather than going silent: over-reporting is the
    // recoverable direction, silence is not.
    return porcelainSourceChanges(cwd);
  }
  const edited = [];
  const deleted = [];
  parseNameStatusZ(worktree, edited, deleted);
  parseNameStatusZ(staged, edited, deleted);
  const dedupe = (list, seen) => list.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  const seen = new Set();
  // A path both deleted from the worktree and (still) staged as an edit is a deletion to
  // restore — the deletion classification wins, so it can never be proposed for commit.
  const del = dedupe(deleted, seen);
  const ed = dedupe(edited, seen);
  return { edited: ed, deleted: del, all: [...ed, ...del] };
}

// Decide what the Stop hook should report for a non-workspace (main-checkout)
// session, given the classified tracked source changes. Pure + side-effect-free so
// the deletion-vs-edit logic is unit-testable without spawning git (#771).
//   - { action: "ok" }       → nothing stranded, let the session stop.
//   - { action: "restore" }  → deletion-dominant desync; tell the agent to RESTORE.
//   - { action: "commit" }   → genuine stranded edits; tell the agent to COMMIT.
function classifyStranded({ edited, deleted, all }) {
  if (all.length === 0) return { action: "ok" };
  // Deletion-dominant working tree: more (or equal) tracked source files DELETED
  // than edited — the signature of a merge working-tree desync, not stranded fixes.
  if (deleted.length > 0 && deleted.length >= edited.length) {
    return { action: "restore", edited, deleted };
  }
  return { action: "commit", files: all };
}

// ---------------------------------------------------------------------------
// Authorship (#709) — WHICH of the dirty files did THIS session write?
//
// Case 2 above has no notion of authorship, so in a checkout shared by several
// agents it reliably tells an uninvolved session to commit someone else's live
// work. Observed three times in one session: a session whose every edit was in a
// DIFFERENT repo was blocked on Stop and handed 14 files from another agent's
// in-flight `execSucceeded` sweep, one of which was a new file referenced by the
// others — a snapshot of which would have committed a non-compiling tree.
//
// That is pressure toward exactly the failure the root CLAUDE.md names by hash
// (`0a7d00bef3`): one agent's changes committed under another's message,
// unrewritable once someone builds on it. An agent that complies produces a bad
// commit; one that refuses argues with a blocking hook every turn.
// ---------------------------------------------------------------------------

/** Tool calls whose input names a file this session wrote. */
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
/** Tool calls whose `command` string may NAME a file the session then wrote through a shell. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Tool calls that fan work out to a SUBAGENT, whose own writes live in another transcript (#720). */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// ---------------------------------------------------------------------------
// #720 — three ways the #709 attribution filter was wrong, all in the SILENT
// direction (a false negative here means the hook says nothing about real
// stranded work, which is strictly worse than over-reporting):
//
//   1. A subagent's writes were invisible: `Agent`/`Task` was in neither tool set,
//      and the subagent's tool calls live in a DIFFERENT transcript file. We now
//      recurse into the sibling `<transcript-without-.jsonl>/subagents/*.jsonl`
//      tree, and when a spawned subagent's transcript cannot be found we fall back
//      to reporting EVERYTHING (pre-#709 behaviour) rather than nothing.
//   2. `cd packages/server && sed -i ... src/services/bar.ts` was not attributed,
//      because the raw command text was substring-matched against the
//      repo-RELATIVE porcelain path. Shell paths are now resolved against the
//      command's effective cwd (tracked across `cd` within the command, based at
//      the transcript entry's own `cwd`) before comparison.
//   3. `cat`/`grep`/`head` of a path made the session its author. Read verbs are
//      now separated from write verbs, so a read never attributes.
//
// Plus: the old `w.endsWith("/" + p)` suffix match attributed a same-relative-path
// file in a DIFFERENT repo. Matching is now anchored at the repo root.
// ---------------------------------------------------------------------------

/** Verbs that only ever READ. A `cat`/`grep`/`head` must never make the session an author (#720). */
const READ_VERBS = new Set([
  // POSIX read/inspect
  "cat", "head", "tail", "less", "more", "bat", "nl", "rev",
  "grep", "rg", "egrep", "fgrep", "ag", "ack", "ripgrep",
  "ls", "dir", "find", "fd", "tree", "stat", "file", "wc", "du", "df", "readlink", "realpath",
  "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "cksum",
  "cut", "sort", "uniq", "tr", "column", "jq", "yq", "xxd", "od", "strings", "fold", "paste", "join",
  "which", "type", "whereis", "pwd", "echo", "printf", "date", "basename", "dirname", "true", "false",
  // PowerShell read/inspect
  "get-content", "get-childitem", "get-item", "get-itemproperty", "select-string", "test-path",
  "measure-object", "select-object", "where-object", "foreach-object", "sort-object", "group-object",
  "resolve-path", "write-host", "write-output", "compare-object", "get-location", "convertfrom-json",
]);

/** Verbs that only write when asked to edit IN PLACE (`sed -i`). Without it they are filters. */
const INPLACE_VERBS = new Set(["sed", "perl", "awk", "gawk", "ruby"]);

/** `git <sub>` subcommands that only read. Anything else (apply, checkout, restore, mv, ...) may write. */
const GIT_READ_SUBS = new Set([
  "status", "diff", "log", "show", "grep", "blame", "ls-files", "ls-tree", "rev-parse", "rev-list",
  "cat-file", "describe", "shortlog", "for-each-ref", "merge-tree", "check-ignore", "check-attr",
  "name-rev", "symbolic-ref", "count-objects", "verify-pack", "whatchanged", "annotate",
]);

/** Wrappers that prefix a real command without changing what it does. */
const VERB_PREFIXES = new Set(["sudo", "command", "time", "nohup", "env", "exec", "builtin", "nice", "xargs"]);

/** Verbs that CHANGE the effective working directory for the rest of the command. */
const CD_VERBS = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);

/** Forward slashes, quotes stripped, drive letter upper-cased so `c:/x` and `C:/x` compare equal. */
function normPath(s) {
  let out = String(s).replace(/\\/g, "/").trim();
  out = out.replace(/^["']/, "").replace(/["']$/, "");
  if (/^[a-z]:/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

function isAbsPath(p) {
  return /^([A-Za-z]:)?\//.test(p);
}

/** Resolve `rel` against `base` (both forward-slash), collapsing `.` and `..`. */
function joinPath(base, rel) {
  const combined = isAbsPath(rel) || !base ? rel : base.replace(/\/+$/, "") + "/" + rel;
  const m = /^([A-Za-z]:)?\//.exec(combined);
  const prefix = m ? (m[1] || "") + "/" : "";
  const out = [];
  for (const seg of combined.slice(m ? m[0].length : 0).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join("/");
}

/** Split a shell/PowerShell command into the segments that run as separate commands. */
function splitSegments(command) {
  return command.split(/\n|&&|\|\||;|\|/g);
}

function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const t = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    if (t !== "") tokens.push(t);
  }
  return tokens;
}

function segmentVerb(tokens) {
  for (const raw of tokens) {
    const t = raw.replace(/^[(){}!]+/, "");
    if (t === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // `FOO=bar cmd`
    const bare = t.replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat|sh)$/i, "");
    const verb = bare.toLowerCase();
    if (VERB_PREFIXES.has(verb)) continue;
    return verb;
  }
  return "";
}

/** Does this token look like a path we could compare against a porcelain entry? */
function looksLikePath(tok) {
  if (tok.startsWith("-")) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) return false;
  return tok.includes("/") || /\.[A-Za-z0-9_]{1,8}$/.test(tok);
}

/** Files this segment REDIRECTS into (`> out.ts`, `>> out.ts`) — written even by a read verb. */
function redirectTargets(segment) {
  const out = [];
  const re = /\d?>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    const t = normPath(m[1]);
    if (!t || t.startsWith("&") || t === "/dev/null" || t.toLowerCase() === "$null") continue;
    out.push(t);
  }
  return out;
}

/** Whether a segment's verb can WRITE at all (defect 3: reads must never attribute). */
function segmentCanWrite(verb, tokens) {
  if (verb === "") return false;
  if (CD_VERBS.has(verb)) return false;
  if (READ_VERBS.has(verb)) return false;
  if (INPLACE_VERBS.has(verb)) {
    return tokens.some((t) => /^-[a-zA-Z]*i/.test(t) || t === "--in-place");
  }
  if (verb === "git") {
    const sub = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
    return !(sub && GIT_READ_SUBS.has(sub.toLowerCase()));
  }
  return true;
}

/**
 * Paths a shell command wrote, resolved against its EFFECTIVE cwd (defect 2).
 *
 * `baseCwd` is the transcript entry's own `cwd` when known; a `cd` inside the command moves it for
 * every later segment. Absolute results go in `abs`, results we could only keep relative (no known
 * base) in `rel` — `attributeToSession` checks both.
 */
function collectShellWrites(command, baseCwd, abs, rel) {
  const base = baseCwd ? normPath(baseCwd) : "";
  let cwd = base;
  for (const segment of splitSegments(normPath(command))) {
    if (!segment.trim()) continue;
    const tokens = tokenize(segment);
    const verb = segmentVerb(tokens);
    if (CD_VERBS.has(verb)) {
      const target = tokens.find((t, i) => i > 0 && !t.startsWith("-"));
      if (!target || target === "-" || target === "~") cwd = base;
      else cwd = joinPath(cwd, normPath(target));
      continue;
    }
    const targets = redirectTargets(segment);
    if (segmentCanWrite(verb, tokens)) {
      for (const t of tokens.slice(1)) {
        const tok = normPath(t);
        if (looksLikePath(tok)) targets.push(tok);
      }
    }
    for (const t of targets) {
      const resolved = joinPath(cwd, t);
      if (isAbsPath(resolved)) abs.add(resolved);
      else rel.add(resolved);
    }
  }
}

// ---------------------------------------------------------------------------
// #724 — IN FLIGHT vs STRANDED.
//
// #720 made the parent see its subagents' writes. That is right, and it created the
// next hazard: an orchestrator that fans work out to N subagents against the shared
// main checkout is now told, on every turn end, to commit files those subagents are
// STILL MID-EDIT (one observed with a syntax error mid-refactor). Committing on that
// advice is exactly the cross-author, broken-intermediate commit the root CLAUDE.md
// names by hash (`0a7d00bef3`).
//
// A subagent's transcript records its terminal result: the last assistant entry of a
// finished subagent carries `stop_reason: "end_turn"`, while a live one ends on an
// unanswered `tool_use` (verified against 26 real subagent transcripts of one
// orchestrator session — every member of the running batch lacked `end_turn`, every
// member of the finished batches had it). The parent's own tool RESULT cannot answer
// this: subagents launch async, so it reads `status: "async_launched"` from the start.
//
// A subagent that DIED without ever closing its turn would otherwise look live
// forever — the silent outcome. So liveness also requires a recently-touched
// transcript: past SUBAGENT_STALE_MS with no write, its files go back to being
// reported as stranded (noise, not silence).
// ---------------------------------------------------------------------------

/** A subagent transcript untouched for this long is no longer treated as live (#724). */
const SUBAGENT_STALE_MS = 20 * 60 * 1000;

function newSink() {
  return {
    writtenAbs: new Set(),
    writtenRel: new Set(),
    agentCalls: 0,
    agentIds: new Set(),
    // Whether the transcript's last assistant turn CLOSED (`stop_reason: "end_turn"`).
    // Reset by any later tool_use, so a closed turn followed by more work counts as open.
    turnClosed: false,
  };
}

/**
 * Does this subagent transcript look like it is still RUNNING?
 * A closed turn means done. An open turn means live, unless the file has gone stale — or its
 * mtime is unreadable, in which case we prefer "not live" (report it) over silence.
 */
function subagentLooksLive(path, sink, nowMs) {
  if (sink.turnClosed) return false;
  let mtimeMs;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  return (typeof nowMs === "number" ? nowMs : Date.now()) - mtimeMs < SUBAGENT_STALE_MS;
}

/** `<dir>/<session-id>.jsonl` -> every `.jsonl` under the sibling `<dir>/<session-id>/` tree. */
function subagentTranscriptFiles(transcriptPath) {
  const dir = normPath(transcriptPath).replace(/\.jsonl$/i, "");
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4 || found.length >= 200) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = d + "/" + e.name;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.jsonl$/i.test(e.name)) found.push(full);
      if (found.length >= 200) return;
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return found;
}

/** Parse one transcript file into `sink`. Returns false when it could not be read at all. */
function parseTranscript(path, sink) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line is normal on a live transcript
    }
    // The parent records a spawned subagent's id in the tool RESULT; that is how we tell
    // "this session had N subagents" apart from "we found N subagent transcripts".
    const resultAgentId = entry?.toolUseResult?.agentId;
    if (typeof resultAgentId === "string") sink.agentIds.add(resultAgentId);
    // Terminal-result tracking (#724): an assistant entry that ends the turn closes it; any
    // later tool_use re-opens it. A transcript left open is a subagent still working.
    if (entry?.type === "assistant" && entry?.message?.stop_reason === "end_turn") sink.turnClosed = true;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const entryCwd = typeof entry?.cwd === "string" ? entry.cwd : null;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      sink.turnClosed = false;
      if (WRITE_TOOLS.has(block.name)) {
        const p = block.input?.file_path ?? block.input?.notebook_path;
        if (typeof p === "string") {
          const np = normPath(p);
          if (isAbsPath(np)) sink.writtenAbs.add(joinPath("", np));
          else if (entryCwd) sink.writtenAbs.add(joinPath(normPath(entryCwd), np));
          else sink.writtenRel.add(joinPath("", np));
        }
      } else if (AGENT_TOOLS.has(block.name)) {
        sink.agentCalls += 1;
      } else if (SHELL_TOOLS.has(block.name) && typeof block.input?.command === "string") {
        collectShellWrites(block.input.command, entryCwd, sink.writtenAbs, sink.writtenRel);
      }
    }
  }
  return true;
}

/**
 * Everything this session's transcript (and its subagents' transcripts) says it WROTE.
 *
 * The shell half is not paranoia — a session that edits with `sed -i` or a heredoc makes no
 * `Edit` call at all, so a write-tool-only scan would silently stop warning about its OWN
 * stranded work. But only WRITE verbs attribute, and the path is resolved against the command's
 * effective cwd rather than substring-matched (#720).
 *
 * Returns `null` when the transcript cannot be read. That is the load-bearing fallback:
 * unknown authorship must degrade to the OLD behaviour (warn about everything), never to
 * silence — a hook that goes quiet when it cannot tell is worse than one that over-reports.
 * The same rule covers a spawned subagent whose transcript we could not find:
 * `subagentAuthorshipUnknown` makes attribution report everything.
 */
function readSessionActivity(transcriptPath, nowMs) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const sink = newSink();
  if (!parseTranscript(transcriptPath, sink)) return null;

  // Each subagent gets its OWN sink so its writes can be marked IN FLIGHT while it is still
  // running (#724); the union is merged back afterwards for authorship exactly as in #720.
  const parsedBasenames = new Set();
  const inFlightAbs = new Set();
  const inFlightRel = new Set();
  let liveSubagents = 0;
  for (const f of subagentTranscriptFiles(transcriptPath)) {
    const sub = newSink();
    if (!parseTranscript(f, sub)) continue;
    parsedBasenames.add(f.split("/").pop().toLowerCase());
    const live = subagentLooksLive(f, sub, nowMs);
    if (live) liveSubagents += 1;
    for (const w of sub.writtenAbs) {
      sink.writtenAbs.add(w);
      if (live) inFlightAbs.add(w);
    }
    for (const w of sub.writtenRel) {
      sink.writtenRel.add(w);
      if (live) inFlightRel.add(w);
    }
    sink.agentCalls += sub.agentCalls;
    for (const id of sub.agentIds) sink.agentIds.add(id);
  }

  // A subagent we KNOW ran but whose transcript we could not read leaves its writes invisible.
  // Silence is the one outcome worse than noise here (#720), so flag it and report everything.
  let subagentAuthorshipUnknown = false;
  if (sink.agentCalls > 0) {
    const resolved = [...sink.agentIds].filter((id) =>
      parsedBasenames.has(`agent-${id}.jsonl`.toLowerCase())
    ).length;
    subagentAuthorshipUnknown = resolved < sink.agentCalls;
  }

  return {
    writtenAbs: sink.writtenAbs,
    writtenRel: sink.writtenRel,
    inFlightAbs,
    inFlightRel,
    liveSubagents,
    agentCalls: sink.agentCalls,
    subagentTranscripts: parsedBasenames.size,
    subagentAuthorshipUnknown,
  };
}

/**
 * Of `paths` (repo-relative, forward slashes), the ones this session appears to have written.
 *
 * `activity === null` (unreadable transcript) or `subagentAuthorshipUnknown` means authorship is
 * unknown, and every path is returned — see above. Otherwise a path is ours when a write tool or a
 * write-verb shell command named it, matched ANCHORED at `repoRoot` so a same-relative-path file in
 * a DIFFERENT repo never cross-attributes (#720).
 */
function matchWritten(paths, writtenAbs, writtenRel, repoRoot) {
  const root = repoRoot ? joinPath("", normPath(repoRoot)).replace(/\/+$/, "") : null;
  const lowerAbs = new Set([...writtenAbs].map((w) => w.toLowerCase()));
  return paths.filter((p) => {
    if (writtenRel.has(p)) return true;
    if (root) {
      const abs = root + "/" + p;
      return writtenAbs.has(abs) || lowerAbs.has(abs.toLowerCase());
    }
    // No repo root to anchor against — fall back to a suffix match, which widens (noise) rather
    // than narrows (silence).
    for (const w of writtenAbs) if (w === p || w.endsWith("/" + p)) return true;
    return false;
  });
}

function attributeToSession(paths, activity, repoRoot) {
  if (!activity) return paths;
  if (activity.subagentAuthorshipUnknown) return paths;
  return matchWritten(paths, activity.writtenAbs, activity.writtenRel, repoRoot);
}

/**
 * Split this session's own dirty files into the two states the message must NOT conflate (#724).
 *
 *   - `inFlight`: a subagent of this session that has NOT reported a terminal result wrote it.
 *     It is being edited RIGHT NOW; committing it snapshots a half-finished (possibly
 *     non-compiling) intermediate under the wrong author. Never demanded.
 *   - `stranded`: everything else this session wrote — its own tool calls, or a subagent that has
 *     finished. This is the work that genuinely blocks auto-merge if it is left behind.
 *
 * A file BOTH the parent and a live subagent wrote counts as in-flight: the subagent's next edit
 * can still break it, so "do not commit" is the safe classification even though we authored it too.
 *
 * Unknown authorship keeps #720's safe direction: EVERYTHING is reported as stranded (under the
 * "authorship UNCERTAIN" header), because we cannot claim a live agent owns any of it.
 */
function partitionAuthored(paths, activity, repoRoot) {
  const mine = attributeToSession(paths, activity, repoRoot);
  if (!activity || activity.subagentAuthorshipUnknown) return { stranded: mine, inFlight: [] };
  const inFlightSet = new Set(
    matchWritten(mine, activity.inFlightAbs || new Set(), activity.inFlightRel || new Set(), repoRoot)
  );
  return {
    stranded: mine.filter((p) => !inFlightSet.has(p)),
    inFlight: mine.filter((p) => inFlightSet.has(p)),
  };
}

/**
 * The Stop-hook verdict for a main-checkout session, as pure data (#724).
 *
 * Two states, deliberately worded so they can never be mistaken for one another:
 *
 *   - STRANDED  — "written by THIS session" + "Commit them before stopping". Blocks (exit 1).
 *   - IN FLIGHT — "still being written by N live subagent(s)" + "Do NOT commit". Informational.
 *
 * Sharing one wording is precisely the #724 bug: the single wording told the session to commit a
 * live subagent's half-finished file. So an all-in-flight tree exits 0 with the informational line
 * instead of demanding anything, and a mixed tree lists the two sets separately (`-` vs `~`) with
 * the commit demand explicitly scoped to the stranded ones.
 */
function buildStopReport({ stranded, inFlight, activity, totalDirty }) {
  const lines = [];
  const mineCount = stranded.length + inFlight.length;
  if (mineCount === 0) return { exitCode: 0, lines };

  const pushInFlight = () => {
    lines.push(
      `IN FLIGHT — ${inFlight.length} of this session's uncommitted source file(s) are still being ` +
        `written by ${activity && activity.liveSubagents ? activity.liveSubagents : inFlight.length} ` +
        "live subagent(s) (no terminal result recorded yet):"
    );
    for (const f of inFlight) lines.push(`  ~ ${f}`);
    lines.push(
      "Do NOT commit the IN FLIGHT files — they are mid-edit and may not even parse. Let those " +
        "subagents finish and commit their own work."
    );
  };

  if (stranded.length === 0) {
    // Every dirty file of ours is in flight: informational only, and the stop is NOT blocked (#724).
    pushInFlight();
    lines.push("Nothing is STRANDED, so this stop is not blocked.");
    return { exitCode: 0, lines };
  }

  const uncertain = !activity || activity.subagentAuthorshipUnknown;
  lines.push(
    uncertain
      ? "WARNING: Uncommitted source changes in the MAIN checkout (authorship UNCERTAIN — see below):"
      : "WARNING: Uncommitted source changes in the MAIN checkout, written by THIS session:"
  );
  for (const f of stranded) lines.push(`  - ${f}`);
  if (inFlight.length > 0) pushInFlight();
  if (activity && activity.subagentAuthorshipUnknown) {
    // #720 defect 1: a subagent's writes live in its own transcript. When one ran and we could not
    // read it, we cannot narrow the list — reporting nothing would hide real stranded work.
    lines.push(
      `(This session spawned ${activity.agentCalls} subagent(s) whose transcript(s) could not all be ` +
        "read, so ALL dirty source files are listed — some may be another agent's in-flight work. " +
        "Check each before committing.)"
    );
  }
  if (activity && typeof totalDirty === "number" && mineCount < totalDirty) {
    lines.push(
      `(${totalDirty - mineCount} other dirty source file(s) are not attributed to this ` +
        "session and are NOT listed — they may be another agent's in-flight work. Do not commit them.)"
    );
  }
  lines.push(
    (inFlight.length > 0
      ? "Commit the STRANDED files listed above (the `-` lines, NOT the `~` IN FLIGHT ones) before stopping"
      : "Commit them before stopping") +
      " — stranded fixes here block auto-merge and can be lost." +
      (activity ? " Commit by pathspec (`git commit -F msg.txt -- <paths>`), never via the shared index." : "")
  );
  return { exitCode: 1, lines };
}

if (require.main !== module) {
  module.exports = {
    trackedSourceChanges,
    porcelainSourceChanges,
    parseNameStatusZ,
    classifyStranded,
    SOURCE_RE,
    readSessionActivity,
    attributeToSession,
    partitionAuthored,
    buildStopReport,
    SUBAGENT_STALE_MS,
  };
}

function lookupWorkspace(sessionId) {
  if (!DatabaseSync) return null;
  const DB_PATH = resolve(__dirname, "../../packages/server/kanban.db");
  if (!sessionId || !existsSync(DB_PATH)) return null;
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
  } catch {
    return null; // DB locked or corrupt — skip
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
      .all();
    if (tables.length === 0) return null;
    const rows = db
      .prepare(
        "SELECT w.branch, w.working_dir, i.title FROM sessions s " +
          "JOIN workspaces w ON s.workspace_id = w.id " +
          "JOIN issues i ON w.issue_id = i.id " +
          "WHERE s.id = ? AND w.status = 'active'"
      )
      .all(sessionId);
    return rows.length > 0 ? rows[0] : null;
  } finally {
    if (db) db.close();
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

  // Loop safety: when a Stop hook is wired directly (e.g. codex .codex/hooks.json,
  // which fires per-turn and can "continue" the turn on a non-zero exit), only
  // nudge on the first stop. On re-entry (stop_hook_active=true) let it through.
  // For Claude this is redundant — smart-hooks-runner already skips non-alwaysRun
  // checks on re-prompt — but harmless.
  if (input.stop_hook_active === true) process.exit(0);

  const ws = lookupWorkspace(input.session_id);

  if (ws) {
    // Case 1: tracked agent session — check its worktree.
    if (!ws.working_dir || !existsSync(ws.working_dir)) process.exit(0);
    if (gitPorcelain(ws.working_dir).trim()) {
      console.error("WARNING: Uncommitted changes found in active worktree:");
      console.error(`  - ${ws.branch} (${ws.title})`);
      console.error("Commit or stash changes before stopping.");
      process.exit(1);
    }
    process.exit(0);
  }

  // Case 2: non-workspace session — check the MAIN checkout for stranded source fixes.
  const mainCheckout = resolve(__dirname, "..", "..");
  const changes = trackedSourceChanges(mainCheckout);
  const verdict = classifyStranded(changes);

  if (verdict.action === "ok") process.exit(0);

  if (verdict.action === "restore") {
    // Deletion-dominant working tree (#771): a merge working-tree desync, NOT stranded
    // fixes. Committing here would remove those files from the branch (e.g. wipe
    // packages/shared). Tell the agent to investigate/restore, never to commit.
    const { deleted, edited } = verdict;
    console.error(
      `WARNING: ${deleted.length} tracked source file(s) are DELETED from the MAIN checkout working tree` +
        (edited.length > 0 ? ` (alongside ${edited.length} edit(s))` : "") + ":"
    );
    for (const f of deleted.slice(0, 10)) console.error(`  - D ${f}`);
    if (deleted.length > 10) console.error(`  - ... and ${deleted.length - 10} more`);
    console.error(
      "This looks like a working-tree DESYNC (e.g. a board merge that regressed the working tree), " +
        "NOT stranded fixes. Do NOT commit — committing would delete these files from the branch. " +
        "Investigate and restore with `git restore <paths>` (or `git restore packages/shared`), then verify the backend is up."
    );
    process.exit(1);
  }

  // verdict.action === "commit": genuine stranded edits — but only OURS (#709). In a shared
  // checkout the dirty set routinely belongs to a co-tenant still working, and telling this
  // session to commit it is pressure toward the cross-author commit the root CLAUDE.md names
  // by hash. `attributeToSession` returns everything when authorship is unknown, so a session
  // with no readable transcript still gets the old, useful warning.
  const activity = readSessionActivity(input.transcript_path);
  const { stranded, inFlight } = partitionAuthored(verdict.files, activity, mainCheckout);
  const report = buildStopReport({ stranded, inFlight, activity, totalDirty: verdict.files.length });
  for (const line of report.lines) console.error(line);
  process.exit(report.exitCode);
}

// #725: guarded by the SAME condition that gates the exports above, which it previously was
// not. `main()` ran unconditionally at module load, so `require`ing this file from a test
// started it — and it only survived under vitest because stdin never ends. A future test that
// closed stdin would have let `main()` proceed to a real `git status` on the main checkout and
// then call `process.exit()`, killing the vitest worker mid-run. #709 and #720 both added
// reasons to import this file from tests, so the trap had become load-bearing.
if (require.main === module) {
  main().catch(() => process.exit(0));
}
