#!/usr/bin/env node
/**
 * List the REAL user-typed prompts across MANY Claude + Codex sessions for a
 * given calendar day (or a rolling window) — answers "what did I ask the agents
 * yesterday" without hand-looping the per-session analyzers.
 *
 * Companion to token-sinks.mjs / tool-failures.mjs (same stat-filter-then-parse
 * fan-out). The hard part is distinguishing a *typed* prompt from the noise that
 * also lands in `type:"user"` entries: tool_results, sidechain/subagent turns,
 * meta entries, slash-command stdout, and injected environment/context blocks.
 * This script filters all of those out.
 *
 * What counts as a user prompt:
 *   Claude  — type=="user", NOT isMeta/isSidechain, content is a string or an
 *             array of text blocks (NO tool_result block), and not pure
 *             <local-command-stdout>/<command-*> wrapper noise.
 *   Codex   — event_msg payload.type=="user_message", excluding injected
 *             <environment_context>/<user_instructions> system preambles.
 *
 * Date scoping uses each ENTRY's own timestamp in LOCAL time (not file mtime —
 * a session can span midnight). mtime is only the cheap pre-filter.
 *
 * Usage:
 *   node scripts/user-prompts.mjs                  # yesterday (local), all providers
 *   node scripts/user-prompts.mjs --date 2026-06-10
 *   node scripts/user-prompts.mjs --today
 *   node scripts/user-prompts.mjs --days 3         # rolling: last N days incl. today
 *   node scripts/user-prompts.mjs --provider claude   # claude | codex | all
 *   node scripts/user-prompts.mjs --full           # don't truncate prompt text
 *   node scripts/user-prompts.mjs --all            # include automated/agent-launch prompts too
 *   node scripts/user-prompts.mjs --json
 *
 * By DEFAULT only HUMAN typed prompts are shown. Automated traffic that also
 * lands in user entries is filtered: builder-launch ticket prompts ("## Workflow
 * … Implement stage"), session handoffs, the Codex board-monitor objective,
 * internal LLM utility calls (ticket prediction, voice-note structuring),
 * harness <task-notification>/<bash-stdout> echoes, and bare UI slash commands
 * (/clear, /model). Pass --all to include them (tagged with their kind).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const provider = opt("--provider", "all"); // claude | codex | all
const asJson = flag("--json");
const full = flag("--full");
const showAll = flag("--all"); // include automated/agent-launch prompts
const tree = flag("--tree"); // hierarchical Project → Day → Chat grouping
const days = parseInt(opt("--days", "0"), 10); // rolling window if > 0

// Resolve the set of local YYYY-MM-DD strings we accept.
function localDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const targetDays = new Set();
let windowStartMs;
if (days > 0) {
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    targetDays.add(localDay(d));
  }
  windowStartMs = Date.now() - days * 86400000 - 86400000; // +1d slack for mtime
} else {
  let dateStr = opt("--date", null);
  if (!dateStr) {
    const d = new Date();
    d.setDate(d.getDate() - (flag("--today") ? 0 : 1));
    dateStr = localDay(d);
  }
  targetDays.add(dateStr);
  // mtime pre-filter: a session touching that day was modified at or after its start.
  windowStartMs = new Date(`${dateStr}T00:00:00`).getTime() - 6 * 3600000;
}

// entry timestamp (ISO/UTC) → local YYYY-MM-DD
const tsLocalDay = (ts) => {
  try { return localDay(new Date(ts)); } catch { return null; }
};
const inWindow = (ts) => {
  const d = tsLocalDay(ts);
  return d && targetDays.has(d);
};
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ── classify a raw user-entry text as human | automated | noise ──────────────
// Returns { kind, text } with text normalized (slash-command/bash-input unwrapped),
// or null to drop the entry entirely.
function classify(raw) {
  const text = (raw || "").trim();
  if (!text) return null;

  // pure harness/echo noise — never a prompt
  if (/^<task-notification>/.test(text)) return null;
  if (/^<bash-stdout>|^<bash-stderr>/.test(text)) return null;
  if (/^<local-command-stdout>/.test(text)) return null;
  if (/^\[Request interrupted/.test(text)) return null;
  if (/^Caveat: The messages below/.test(text)) return null;

  // user-typed shell command (bash mode) → unwrap to "! cmd"
  const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>\s*$/);
  if (bash) return { kind: "human", text: `! ${bash[1].trim()}` };

  // slash command: <command-name>/x</command-name> ... <command-args>args</command-args>
  if (/<command-name>/.test(text)) {
    const name = (text.match(/<command-name>([^<]*)<\/command-name>/)?.[1] || "").trim().replace(/^\//, "");
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || "").trim();
    if (!name) return null;
    if (!args) {
      // bare UI command (/clear, /model, /fast …) — noise unless --all
      return { kind: "noise", text: `/${name}` };
    }
    return { kind: "human", text: `/${name} ${args}` };
  }

  // automated agent traffic that lands in user entries
  if (/^\[SESSION HANDOFF/.test(text)) return { kind: "automated", text };
  if (/^You are the autonomous BOARD MONITOR/.test(text)) return { kind: "automated", text };
  if (/^Base directory for this skill:/.test(text)) return { kind: "automated", text };
  // internal LLM utility calls (file prediction, voice-note → ticket, etc.)
  if (/^You are a (project manager assistant|software engineer)/.test(text)) return { kind: "automated", text };
  // builder launch prompt = a ticket body, usually with the workflow preamble
  if (/stage of this issue's workflow/.test(text) || /^##\s+Workflow/m.test(text)) {
    return { kind: "automated", text };
  }

  return { kind: "human", text };
}

// ── extract user prompts from one Claude transcript ──────────────────────────
function claudePrompts(path) {
  const out = [];
  let lines;
  try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return out; }
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type !== "user") continue;
    if (obj.isMeta || obj.isSidechain) continue;
    if (obj.toolUseResult !== undefined) continue; // tool result, not a prompt
    if (!inWindow(obj.timestamp)) continue;
    const content = obj.message?.content;
    let raw = null;
    if (typeof content === "string") raw = content;
    else if (Array.isArray(content)) {
      if (content.some((b) => b.type === "tool_result")) continue;
      raw = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const c = classify(raw);
    if (!c) continue;
    if (!showAll && c.kind !== "human") continue;
    out.push({ ts: obj.timestamp, text: c.text, kind: c.kind });
  }
  return out;
}

// ── extract user prompts from one Codex transcript ───────────────────────────
function codexPrompts(path) {
  const out = [];
  let lines;
  try { lines = readFileSync(path, "utf-8").split("\n"); } catch { return out; }
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type !== "event_msg") continue;
    if (obj.payload?.type !== "user_message") continue;
    if (!inWindow(obj.timestamp)) continue;
    const text = (obj.payload.message || "").trim();
    if (!text) continue;
    // skip injected system preambles, not human prompts
    if (/^<environment_context>/.test(text)) continue;
    if (/^<user_instructions>/.test(text)) continue;
    if (/^# AGENTS\.md|^<\/?user_instructions>/.test(text)) continue;
    const c = classify(text);
    if (!c) continue;
    if (!showAll && c.kind !== "human") continue;
    out.push({ ts: obj.timestamp, text: c.text, kind: c.kind });
  }
  return out;
}

// ── collectors (mtime pre-filter, then per-entry date filter) ────────────────
function collectClaude() {
  const base = join(homedir(), ".claude", "projects");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    const dirPath = join(base, dir);
    let files;
    try { files = readdirSync(dirPath); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dirPath, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < windowStartMs) continue;
      const prompts = claudePrompts(p);
      if (prompts.length) out.push({ provider: "claude", project: dir, sessionId: f.replace(/\.jsonl$/, ""), prompts });
    }
  }
  return out;
}

function collectCodex() {
  const base = join(homedir(), ".codex", "sessions");
  const out = [];
  if (!existsSync(base)) return out;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".jsonl")) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < windowStartMs) continue;
      const prompts = codexPrompts(p);
      if (prompts.length) {
        // pull cwd for a friendlier project label
        let cwd = "";
        try {
          for (const ln of readFileSync(p, "utf-8").split("\n")) {
            if (!ln.trim()) continue;
            const o = JSON.parse(ln);
            if (o.type === "session_meta" && o.payload?.cwd) { cwd = o.payload.cwd; break; }
          }
        } catch { /* ignore */ }
        out.push({ provider: "codex", project: cwd || "(unknown)", sessionId: e.name.replace(/\.jsonl$/, ""), prompts });
      }
    }
  };
  walk(base);
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
const sessions = [];
if (provider === "all" || provider === "claude") sessions.push(...collectClaude());
if (provider === "all" || provider === "codex") sessions.push(...collectCodex());

// flatten + sort chronologically
const all = [];
for (const sess of sessions) {
  for (const pr of sess.prompts) {
    all.push({ ts: pr.ts, text: pr.text, kind: pr.kind, provider: sess.provider, project: sess.project, sessionId: sess.sessionId });
  }
}
all.sort((a, b) => new Date(a.ts) - new Date(b.ts));

if (asJson) {
  console.log(JSON.stringify({ days: [...targetDays], count: all.length, prompts: all }, null, 2));
  process.exit(0);
}

const daysSpan = [...targetDays].sort();
const label = daysSpan.length > 3 ? `${daysSpan[0]} … ${daysSpan[daysSpan.length - 1]}` : daysSpan.join(", ");
console.log(`\nUser prompts — ${label}  (${all.length} prompts across ${sessions.length} sessions)\n`);

const shorten = (p) => (p.length > 56 ? "…" + p.slice(-54) : p);
const clip = (t) => {
  const oneLine = t.replace(/\s+/g, " ").trim();
  return full ? t.trim() : oneLine.length > 200 ? oneLine.slice(0, 197) + "…" : oneLine;
};
const renderPrompt = (pr, indent) => {
  const tag = showAll && pr.kind !== "human" ? `[${pr.kind}] ` : "";
  const head = `${indent}${hhmm(pr.ts)}  ${tag}`;
  const pad = " ".repeat(head.length);
  console.log(`${head}${clip(pr.text).split("\n").join("\n" + pad)}`);
};

if (tree) {
  // Project → Day → Chat (session). Within a day, chats ordered by first prompt.
  const byProject = new Map();
  for (const pr of all) {
    if (!byProject.has(pr.project)) byProject.set(pr.project, new Map());
    const byDay = byProject.get(pr.project);
    const day = tsLocalDay(pr.ts);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const byChat = byDay.get(day);
    if (!byChat.has(pr.sessionId)) byChat.set(pr.sessionId, []);
    byChat.get(pr.sessionId).push(pr);
  }
  // projects sorted by total prompt volume (busiest first)
  const projTotal = (m) => [...m.values()].reduce((s, byChat) => s + [...byChat.values()].reduce((a, c) => a + c.length, 0), 0);
  const projects = [...byProject.entries()].sort((a, b) => projTotal(b[1]) - projTotal(a[1]));
  for (const [project, byDay] of projects) {
    console.log(`\n══ ${shorten(project)}   (${projTotal(byDay)} prompts)`);
    for (const day of [...byDay.keys()].sort()) {
      const byChat = byDay.get(day);
      const dayCount = [...byChat.values()].reduce((a, c) => a + c.length, 0);
      const chats = [...byChat.values()].length;
      console.log(`\n   ▸ ${day}   (${dayCount} prompts · ${chats} chat${chats > 1 ? "s" : ""})`);
      // chats ordered by their first prompt's time
      const ordered = [...byChat.entries()].sort((a, b) => new Date(a[1][0].ts) - new Date(b[1][0].ts));
      for (const [sid, prompts] of ordered) {
        console.log(`      · chat ${sid.slice(0, 8)}`);
        for (const pr of prompts) renderPrompt(pr, "          ");
      }
    }
  }
  console.log("");
} else {
  let lastSession = "";
  for (const pr of all) {
    if (pr.sessionId !== lastSession) {
      console.log(`\n── [${pr.provider}] ${shorten(pr.project)}  ·  ${pr.sessionId.slice(0, 8)}`);
      lastSession = pr.sessionId;
    }
    renderPrompt(pr, "  ");
  }
  console.log("");
}
