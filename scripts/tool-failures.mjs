#!/usr/bin/env node
/**
 * Aggregate FAILED tool calls across MANY Claude + Codex sessions over a time
 * window and rank them — answers "which tools fail most / what are the agents
 * fighting in the last N days" without looping the per-session analyzers.
 *
 * Sibling to token-sinks.mjs (same stat-filter-then-parse fan-out) and to the
 * per-session analyze-{claude,codex}-session.mjs (those report one session's
 * failures). This one ranks fleet-wide by tool, project, error signature, or
 * day, and surfaces the top recurring error excerpts.
 *
 * Failure detection:
 *   Claude — a user `tool_result` block with `is_error: true`, mapped back to
 *            its tool via `tool_use_id` (same logic as analyze-claude-session).
 *   Codex  — a `function_call_output` whose `output` reports a nonzero
 *            "Exit code: N", mapped back to its tool via `call_id`.
 *
 * Usage:
 *   node scripts/tool-failures.mjs                    # last 7d, by tool, ranked by failures
 *   node scripts/tool-failures.mjs --days 14
 *   node scripts/tool-failures.mjs --by project       # tool (default) | project | error | day
 *   node scripts/tool-failures.mjs --by error         # cluster by normalized error signature
 *   node scripts/tool-failures.mjs --provider claude  # claude | codex | all
 *   node scripts/tool-failures.mjs --sort rate        # failures (default) | rate
 *   node scripts/tool-failures.mjs --min 20           # min total calls for --sort rate (default 10)
 *   node scripts/tool-failures.mjs --top 30
 *   node scripts/tool-failures.mjs --json
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// normalize an error message into a clusterable signature
function errSig(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/[A-Za-z]:\\[^\s"']+|\/[^\s"':]+/g, "<path>") // win + posix paths
    .replace(/0x[0-9a-fA-F]+|\b\d+\b/g, "N") // hex + numbers
    .replace(/'[^']*'|"[^"]*"/g, "<q>") // quoted strings
    .trim()
    .slice(0, 90);
}

// ── parse one Claude transcript → per-tool {count, failed} + error excerpts ──
function parseClaude(path) {
  const toolNameById = new Map();
  const tools = new Map(); // name -> { count, failed }
  const errors = []; // raw excerpt strings (failures only)
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    const msg = obj.message;
    if (!msg) continue;
    if (obj.type === "assistant") {
      for (const b of msg.content || []) {
        if (b.type === "tool_use") {
          const name = b.name || "unknown";
          toolNameById.set(b.id, name);
          const e = tools.get(name) || { count: 0, failed: 0 };
          e.count++;
          tools.set(name, e);
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type === "tool_result" && b.is_error) {
          const name = toolNameById.get(b.tool_use_id) || "unknown";
          const e = tools.get(name) || { count: 0, failed: 0 };
          e.failed++;
          tools.set(name, e);
          const text = Array.isArray(b.content)
            ? b.content.map((c) => c.text || "").join(" ")
            : String(b.content || "");
          if (text) errors.push({ tool: name, text: text.slice(0, 300) });
        }
      }
    }
  }
  return { tools, errors };
}

// ── parse one Codex transcript → per-tool {count, failed} + error excerpts ──
function parseCodex(path) {
  const callName = new Map(); // call_id -> tool name
  const tools = new Map();
  const errors = [];
  let cwd = "";
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta" && p.cwd) cwd = p.cwd;
    if (obj.type !== "response_item") continue;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = p.name || (p.type === "custom_tool_call" ? "custom_tool" : "unknown");
      if (p.call_id) callName.set(p.call_id, name);
      const e = tools.get(name) || { count: 0, failed: 0 };
      e.count++;
      tools.set(name, e);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const name = callName.get(p.call_id) || "unknown";
      const out = typeof p.output === "string" ? p.output
        : (p.output && typeof p.output.content === "string" ? p.output.content : "");
      const m = out.match(/Exit code:\s*(\d+)/);
      const failed = m ? parseInt(m[1], 10) !== 0 : false;
      if (failed) {
        const e = tools.get(name) || { count: 0, failed: 0 };
        e.failed++;
        tools.set(name, e);
        // grab the part after the Output: marker for a useful signature
        const body = out.split(/Output:\s*/).slice(1).join("Output: ") || out;
        errors.push({ tool: name, text: body.slice(0, 300) });
      }
    }
  }
  return { tools, errors, cwd };
}

// ── collect sessions in the window ───────────────────────────────────────────
function collectClaude(cutoffMs) {
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
      if (st.mtimeMs < cutoffMs) continue;
      out.push({ provider: "claude", project: dir, id: p, modified: st.mtime, ...parseClaude(p) });
    }
  }
  return out;
}
function collectCodex(cutoffMs) {
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
      if (st.mtimeMs < cutoffMs) continue;
      const parsed = parseCodex(p);
      out.push({ provider: "codex", project: parsed.cwd || "(unknown)", id: p, modified: st.mtime, ...parsed });
    }
  };
  walk(base);
  return out;
}

// ── formatting ───────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
const pct = (f, c) => (c ? `${Math.round((100 * f) / c)}%` : "—");

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const days = parseInt(flag("days", "7"), 10);
const by = flag("by", "tool"); // tool | project | error | day
const provider = flag("provider", "all");
const sort = flag("sort", "failures"); // failures | rate
const minCalls = parseInt(flag("min", "10"), 10);
const top = parseInt(flag("top", "25"), 10);
const jsonOut = args.includes("--json");

const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
const sessions = [];
if (provider === "all" || provider === "claude") sessions.push(...collectClaude(cutoffMs));
if (provider === "all" || provider === "codex") sessions.push(...collectCodex(cutoffMs));

// fleet totals
let totalCalls = 0, totalFailed = 0;
for (const s of sessions) for (const e of s.tools.values()) { totalCalls += e.count; totalFailed += e.failed; }

// group
const groups = new Map();
const bump = (key, count, failed) => {
  let g = groups.get(key);
  if (!g) { g = { key, count: 0, failed: 0, sessions: new Set() }; groups.set(key, g); }
  g.count += count;
  g.failed += failed;
  return g;
};
if (by === "error") {
  // cluster failures by normalized error signature (only failures carry text)
  for (const s of sessions) {
    for (const err of s.errors) {
      const g = bump(errSig(err.text), 0, 1);
      g.sessions.add(s.id);
      if (!g.sampleTool) g.sampleTool = err.tool;
    }
  }
} else {
  for (const s of sessions) {
    for (const [name, e] of s.tools) {
      const key = by === "project" ? s.project
        : by === "day" ? s.modified.toISOString().slice(0, 10)
        : name; // tool
      const g = bump(key, e.count, e.failed);
      g.sessions.add(s.id);
    }
  }
}

let rows = [...groups.values()].map((g) => ({ ...g, rate: g.count ? g.failed / g.count : 0, nSessions: g.sessions.size }));
if (sort === "rate") {
  rows = rows.filter((r) => r.count >= minCalls).sort((a, b) => b.rate - a.rate || b.failed - a.failed);
} else {
  rows.sort((a, b) => b.failed - a.failed || b.count - a.count);
}

if (jsonOut) {
  console.log(JSON.stringify({ days, by, provider, sort, totalCalls, totalFailed, rows: rows.slice(0, top) }, null, 2));
  process.exit(0);
}

console.log("═".repeat(78));
console.log(`FAILED TOOL CALLS — last ${days}d · by ${by} · sorted by ${sort} · provider=${provider}`);
console.log("═".repeat(78));
console.log(`Total tool calls: ${totalCalls.toLocaleString()}   Failed: ${totalFailed.toLocaleString()}  (${pct(totalFailed, totalCalls)})   Sessions: ${sessions.length}`);
console.log("─".repeat(78));

if (by === "error") {
  console.log(`${padL("fails", 6)} ${padL("sess", 5)} ${pad("sample tool", 16)} error signature`);
  console.log("─".repeat(78));
  for (const r of rows.slice(0, top)) {
    console.log(`${padL(r.failed, 6)} ${padL(r.nSessions, 5)} ${pad(r.sampleTool || "", 16)} ${r.key}`);
  }
} else {
  const w = by === "project" ? 42 : 24;
  console.log(`${pad(by, w)} ${padL("fails", 7)} ${padL("calls", 8)} ${padL("rate", 6)} ${padL("sess", 5)}`);
  console.log("─".repeat(78));
  for (const r of rows.slice(0, top)) {
    console.log(`${pad(r.key, w)} ${padL(r.failed, 7)} ${padL(r.count, 8)} ${padL(pct(r.failed, r.count), 6)} ${padL(r.nSessions, 5)}`);
  }
}
console.log("═".repeat(78));
console.log(
  "Claude failures = tool_result is_error; Codex = nonzero 'Exit code:' in function_call_output.\n" +
  "--by error clusters the failure messages; --sort rate needs --min total calls (default 10).",
);
