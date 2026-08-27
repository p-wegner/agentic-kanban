#!/usr/bin/env node
// @board-hook-version: 1
/**
 * disclose-context.mjs — PostToolUse hook that closes the progressive-disclosure gap.
 *
 * Claude Code loads a nested `CLAUDE.md` and a path-scoped `.claude/rules/*.md` only when
 * the agent READS a matching file through the Read tool. Agents increasingly use `grep`,
 * `cat`, `sed -n`, `head` in Bash — and the built-in Grep/Glob tools — instead. Those touch
 * the same files but trigger nothing, so the guidance for that subtree never arrives.
 *
 * This hook runs after Bash / Grep / Glob (configurable), extracts every path the call
 * touched (from the command line AND from the tool's output), resolves which nested
 * CLAUDE.md files and which path-scoped rules apply, and injects the ones this session has
 * not seen yet as `additionalContext` — exactly what the agent would have received had it
 * used Read.
 *
 * Zero dependencies. Exit 0 always (never blocks a tool call).
 *
 * Deliberately uses a PLAIN RELATIVE path when wired in settings.json (never
 * `$CLAUDE_PROJECT_DIR`): that variable is empty in `claude -p` sessions and Claude Code
 * pre-expands it textually before spawn, so node would look for `C:\.claude\hooks\...` and
 * fail non-blockingly. `projectRoot()` below self-locates via `.claude`/`.git` walk-up
 * instead of trusting the env var.
 *
 * Env knobs (KANBAN_ prefixed — see docs/env-vars.md):
 *   KANBAN_DISCLOSE_STATE_DIR   where per-session "already injected" state lives (default: os tmpdir)
 *   KANBAN_DISCLOSE_LOG=1       one-line stderr trace per invocation (visible in `claude --debug`)
 *   KANBAN_DISCLOSE_ALL_TOOLS=1 also handle Read/Edit/Write (normally Claude Code covers those)
 *   KANBAN_DISCLOSE_DISABLED=1  no-op (the control arm of the eval)
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, relative, sep, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const READ_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

main().catch((e) => { log(`error: ${e?.stack || e}`); process.exit(0); });

async function main() {
  if (process.env.KANBAN_DISCLOSE_DISABLED) return;
  const input = JSON.parse(await readStdin() || "{}");
  const tool = input.tool_name || "";
  const handled = SHELL_TOOLS.has(tool) || SEARCH_TOOLS.has(tool) || (process.env.KANBAN_DISCLOSE_ALL_TOOLS && READ_TOOLS.has(tool));
  if (!handled) return;

  const cwd = input.cwd || process.cwd();
  const root = projectRoot(cwd);
  const touched = touchedPaths(input, cwd, root);
  if (!touched.length) { log(`${tool}: no paths`); return; }

  // Per-session dedup state is read-modify-write across possibly-concurrent PostToolUse
  // invocations within one turn (several Grep/Bash calls in a row) — guard with a lock so
  // two racing processes don't both see the stale "not yet injected" state and duplicate.
  const unlock = acquireStateLock(input.session_id);
  try {
    const state = loadState(input.session_id);
    const docs = []; // {file, reason}
    const seen = new Set(state.injected);

    for (const p of touched) {
      // 1. nested CLAUDE.md files between the project root (exclusive) and the touched path
      for (const md of nestedMemoryFiles(p, root)) {
        if (!seen.has(md)) { seen.add(md); docs.push({ file: md, reason: `nested CLAUDE.md for ${rel(root, p)}` }); }
      }
      // 2. path-scoped rules whose globs match the touched path
      for (const rule of pathScopedRules(root)) {
        if (rule.globs.some((g) => g.test(rel(root, p)))) {
          if (!seen.has(rule.file)) { seen.add(rule.file); docs.push({ file: rule.file, reason: `rule paths match ${rel(root, p)}` }); }
        }
      }
    }

    if (!docs.length) { log(`${tool}: ${touched.length} path(s), nothing new`); return; }

    state.injected = [...seen];
    saveState(input.session_id, state);

    const blocks = docs.map((d) => {
      const body = readFileSync(d.file, "utf8").replace(/^---[\s\S]*?---\s*/, ""); // strip frontmatter
      return `<disclosed-context source="${rel(root, d.file)}" reason="${d.reason}">\n${body.trim()}\n</disclosed-context>`;
    });
    const additionalContext =
      `The ${tool} call touched files covered by project guidance that is only auto-loaded on Read. ` +
      `Treat the following exactly as if you had read the files yourself:\n\n${blocks.join("\n\n")}`;

    log(`${tool}: injected ${docs.map((d) => rel(root, d.file)).join(", ")}`);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));
  } finally {
    unlock();
  }
}

// ---------- path extraction ----------

function touchedPaths(input, cwd, root) {
  const out = new Set();
  const add = (cand, base) => {
    if (!cand) return;
    let s = String(cand).replace(/^["'`]+|["'`,;:)]+$/g, "");
    s = s.replace(/:\d+(:\d+)?$/, ""); // grep's file:line:col
    if (!s || s.startsWith("-")) return;
    const abs = isAbsolute(s) ? s : resolve(base, s);
    if (!inside(root, abs)) return;
    try { if (existsSync(abs)) out.add(resolve(abs)); } catch { /* ignore */ }
  };
  const ti = input.tool_input || {};
  const name = input.tool_name;

  if (SHELL_TOOLS.has(name)) {
    let base = cwd;
    for (const seg of String(ti.command || "").split(/&&|\|\||;|\|/)) {
      const toks = seg.trim().split(/\s+/);
      if (toks[0] === "cd" && toks[1]) { const d = isAbsolute(toks[1]) ? toks[1] : resolve(base, toks[1]); if (existsSync(d)) base = d; continue; }
      for (const t of toks) {
        add(t, base);
        // grep/rg/sed style patterns can carry "path" after the pattern; also handle a=b
        const eq = t.indexOf("="); if (eq > 0) add(t.slice(eq + 1), base);
      }
    }
  } else if (name === "Grep" || name === "Glob") {
    add(ti.path, cwd);
  } else if (READ_TOOLS.has(name)) {
    add(ti.file_path || ti.notebook_path, cwd);
  }

  // Output: any line/token that is an existing path (Grep filename lists, `ls`, `find`, `grep -l`, `file:line:` hits)
  const resp = input.tool_response ?? input.tool_result;
  for (const line of responseText(resp).split(/\r?\n/).slice(0, 2000)) {
    const l = line.trim(); if (!l) continue;
    add(l, cwd);
    const m = l.match(/^([^:\s]+?):\d+[:-]/); if (m) add(m[1], cwd); // file:line:content / file-line-context
    if (l.length < 400) for (const t of l.split(/\s+/)) if (/[\\/.]/.test(t)) add(t, cwd);
  }
  return [...out];
}

function responseText(resp) {
  if (resp == null) return "";
  if (typeof resp === "string") return resp;
  if (Array.isArray(resp)) return resp.map(responseText).join("\n");
  if (typeof resp === "object") {
    const parts = [];
    for (const k of ["stdout", "stderr", "content", "text", "output", "result"]) if (resp[k] != null) parts.push(responseText(resp[k]));
    if (Array.isArray(resp.filenames)) parts.push(resp.filenames.join("\n"));
    if (!parts.length) parts.push(JSON.stringify(resp));
    return parts.join("\n");
  }
  return String(resp);
}

// ---------- guidance discovery ----------

function nestedMemoryFiles(absPath, root) {
  const out = [];
  let dir = statSafe(absPath)?.isDirectory() ? absPath : dirname(absPath);
  while (inside(root, dir) && resolve(dir) !== resolve(root)) {
    for (const n of ["CLAUDE.md", "CLAUDE.local.md"]) { const f = join(dir, n); if (existsSync(f)) out.push(f); }
    dir = dirname(dir);
  }
  return out.reverse(); // outermost first, like Claude Code's own precedence
}

let rulesCache;
function pathScopedRules(root) {
  if (rulesCache) return rulesCache;
  rulesCache = [];
  for (const dir of [join(homedir(), ".claude", "rules"), join(root, ".claude", "rules")]) {
    for (const f of walk(dir)) {
      if (!f.endsWith(".md")) continue;
      const paths = frontmatterPaths(readFileSync(f, "utf8"));
      if (paths.length) rulesCache.push({ file: f, globs: paths.map(globToRegex) });
      // rules WITHOUT paths are loaded at launch by Claude Code — nothing to disclose
    }
  }
  return rulesCache;
}

function frontmatterPaths(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/); if (!m) return [];
  const fm = m[1];
  const inline = fm.match(/^paths:\s*\[(.*)\]\s*$/m);
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const block = fm.match(/^paths:\s*\r?\n((?:\s*-\s*.*\r?\n?)+)/m);
  if (block) return block[1].split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return [];
}

function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { const slash = glob[i + 2] === "/"; re += slash ? "(?:.*/)?" : ".*"; i += slash ? 2 : 1; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = glob.indexOf("}", i); re += "(?:" + glob.slice(i + 1, j).split(",").map(esc).join("|") + ")"; i = j; }
    else re += esc(c);
  }
  return new RegExp("^" + re + "$");
}
const esc = (s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&");

// ---------- state ----------

function stateFile(sid) {
  const dir = process.env.KANBAN_DISCLOSE_STATE_DIR || join(tmpdir(), "claude-disclose-context");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${(sid || "nosession").replace(/[^\w-]/g, "_")}.json`);
}
function loadState(sid) { try { return JSON.parse(readFileSync(stateFile(sid), "utf8")); } catch { return { injected: [] }; } }
function saveState(sid, s) { try { writeFileSync(stateFile(sid), JSON.stringify(s)); } catch { /* ignore */ } }

/**
 * mkdir-as-lock around the state file: several Grep/Bash PostToolUse hooks can fire for the
 * same session within one turn, and a load-modify-save race would let two of them both see
 * the pre-update "injected" set and duplicate an injection. `mkdir` is atomic even on a
 * shared filesystem, so it doubles as the lock primitive. Bounded retry so a stuck/stale
 * lock (e.g. a killed hook process) cannot wedge every future call for the session.
 */
function acquireStateLock(sid) {
  const lockDir = `${stateFile(sid)}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => { try { rmdirSync(lockDir); } catch { /* ignore */ } };
    } catch {
      if (Date.now() > deadline) return () => {}; // proceed unlocked rather than hang the tool call
    }
  }
}

// ---------- utils ----------

function projectRoot(cwd) {
  let d = resolve(cwd);
  for (;;) { if (existsSync(join(d, ".claude")) || existsSync(join(d, ".git"))) return d; const p = dirname(d); if (p === d) return resolve(cwd); d = p; }
}
function inside(root, p) { const r = relative(resolve(root), resolve(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); }
function rel(root, p) { return relative(root, p).split(sep).join("/"); }
function statSafe(p) { try { return statSync(p); } catch { return null; } }
function* walk(dir) { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { const f = join(dir, e.name); if (e.isDirectory()) yield* walk(f); else yield f; } }
function readStdin() { return new Promise((res) => { let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); if (process.stdin.isTTY) res(""); }); }
function log(m) { if (process.env.KANBAN_DISCLOSE_LOG) process.stderr.write(`[disclose-context] ${m}\n`); }
