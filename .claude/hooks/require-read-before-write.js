#!/usr/bin/env node
/**
 * Require Read before Write — pre-empt the "File has not been read yet" tool error.
 *
 * Runs as a PreToolUse hook on the Read and Write tools.
 *
 * Why: the Write tool refuses to overwrite an EXISTING file that wasn't Read first
 * ("File has not been read yet. Read it first before writing to it."). Fleet data
 * showed ~50 such failures/week across 42 sessions — each costing 2 extra turns
 * (Write fails → Read → Write retry). This hook fires mechanically BEFORE the Write
 * reaches the tool, so the agent gets the "read it first" guidance one turn earlier
 * instead of as a wasted tool call (ticket #760).
 *
 * Behaviour:
 *   - On Read: record the normalised target path into a per-session state file.
 *   - On Write: ALLOW when
 *       * the target file does NOT exist yet (creating a new file needs no prior Read), OR
 *       * the target path was Read earlier in this session.
 *     Otherwise BLOCK with "Read `<path>` first before writing to it."
 *
 * Conservative by design: it only blocks the exact case the tool itself rejects
 * (overwrite of an existing-but-unread file), so it never blocks a legitimate Write.
 *
 * State: .claude/hooks/.read-tracking-state.json — { "<sessionId>": ["<path>", ...] }
 *   Keyed by session so concurrent agents don't see each other's reads. Capped per
 *   session (most-recent-N) and to a handful of sessions so the file can't grow without
 *   bound. Best-effort: any state/IO failure falls through to ALLOW (never blocks on a
 *   bug in this hook).
 *
 * Override: set ALLOW_WRITE_WITHOUT_READ=1.
 *
 * Codex: registered for the Claude harness only — the "File has not been read yet"
 * constraint is Claude-Code-specific. The input parsing below still tolerates Codex's
 * `tool_name` / `tool_input` field names and read/write tool aliases, so the script is
 * safe to wire into `.codex/hooks.json` later if Codex grows the same constraint, but it
 * is intentionally NOT registered there yet (a harness whose write tools don't require a
 * prior read would only get false blocks).
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const READ_TOOLS = new Set(["Read", "read_file", "view", "view_file"]);
const WRITE_TOOLS = new Set(["Write", "write_file", "create_file"]);

const MAX_PATHS_PER_SESSION = 500;
const MAX_SESSIONS = 8;

/** Normalise a path for case-insensitive, separator-insensitive comparison (Windows-friendly). */
function norm(p) {
  if (!p) return "";
  let r = path.resolve(p).replace(/\\/g, "/");
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
  return r.toLowerCase();
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

function getStatePath(cwd) {
  const root = gitToplevel(cwd) || cwd;
  return path.join(root, ".claude", "hooks", ".read-tracking-state.json");
}

function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function saveState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* best-effort: never fail the tool because state couldn't persist */
  }
}

/** Extract the target file path from a read/write tool input. */
function targetPath(toolInput) {
  if (!toolInput) return null;
  return (
    toolInput.file_path ||
    toolInput.filePath ||
    toolInput.path ||
    toolInput.notebook_path ||
    toolInput.notebookPath ||
    null
  );
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

async function main() {
  if (process.env.ALLOW_WRITE_WITHOUT_READ === "1") allow();

  const input = await readInput();
  if (!input) allow();

  const toolName = input.tool_name || input.toolName;
  const isRead = READ_TOOLS.has(toolName);
  const isWrite = WRITE_TOOLS.has(toolName);
  if (!isRead && !isWrite) allow();

  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const rawTarget = targetPath(input.tool_input || input.toolInput);
  if (!rawTarget) allow();

  const target = norm(path.isAbsolute(rawTarget) ? rawTarget : path.join(cwd, rawTarget));
  const sessionId = input.session_id || input.sessionId || "default";
  const statePath = getStatePath(cwd);

  if (isRead) {
    const state = loadState(statePath);
    const list = Array.isArray(state[sessionId]) ? state[sessionId] : [];
    // Move-to-front, dedup, cap (most-recently-read kept).
    const next = [target, ...list.filter((p) => p !== target)].slice(0, MAX_PATHS_PER_SESSION);
    state[sessionId] = next;
    // Bound the number of tracked sessions (drop oldest-inserted keys).
    const keys = Object.keys(state);
    if (keys.length > MAX_SESSIONS) {
      for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) delete state[k];
    }
    saveState(statePath, state);
    allow();
  }

  // isWrite:
  // Creating a NEW file never triggers the tool's read-first guard — only overwrites do.
  // Resolve against `cwd` (CLAUDE_PROJECT_DIR), same base as the read-history lookup, so a
  // relative file_path is checked at the same location it was tracked — not against
  // process.cwd(), which can differ.
  const absTarget = path.isAbsolute(rawTarget) ? rawTarget : path.join(cwd, rawTarget);
  let exists = false;
  try {
    exists = fs.existsSync(absTarget);
  } catch {
    exists = false;
  }
  if (!exists) allow();

  const state = loadState(statePath);
  const list = Array.isArray(state[sessionId]) ? state[sessionId] : [];
  if (list.includes(target)) allow();

  block(
    `Read \`${rawTarget}\` first before writing to it.\n\n` +
      "The Write tool refuses to overwrite an existing file that hasn't been Read in this " +
      "session (it errors with \"File has not been read yet\"). Read the file first so you " +
      "edit its real current contents instead of guessing — then Write.\n\n" +
      "(If you genuinely must bypass this, set ALLOW_WRITE_WITHOUT_READ=1. Do NOT edit this hook.)"
  );
}

main().catch(() => process.exit(0));
