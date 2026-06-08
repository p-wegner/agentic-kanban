#!/usr/bin/env node
/**
 * Aggregate token usage across MANY Claude + Codex sessions over a time window
 * and rank the biggest "token sinks" — answers "what burned the most tokens in
 * the last N days" without hand-looping the per-session analyzers.
 *
 * Companion to analyze-{claude,codex}-session.mjs (those debug ONE session);
 * this one fans out over all sessions, tallies tokens, and ranks. It is the
 * cheap path for the session-inspector skill's "biggest token sinks" query:
 * stat-filter by mtime FIRST, parse only the files inside the window.
 *
 * Token accounting (Claude): each assistant turn's usage is a separate billed
 * API call, so we SUM input/output/cache_creation/cache_read across turns.
 * cache_read dominates raw counts but is ~0.1x price — so we also compute an
 * estimated USD cost with per-model pricing, which is the truer "sink" ranking.
 *
 * Pricing $/1M (input / output), cache_read ~0.1x input, cache_write ~1.25x input:
 *   opus  5 / 25   sonnet 3 / 15   haiku 1 / 5   (claude-api skill, 2026-05-26)
 * Codex tokens are counted but not costed (different provider/pricing).
 *
 * Usage:
 *   node scripts/token-sinks.mjs                      # last 7 days, ranked by cost
 *   node scripts/token-sinks.mjs --days 14            # change the window
 *   node scripts/token-sinks.mjs --by project         # group by cwd/project (default: session)
 *   node scripts/token-sinks.mjs --by day             # group by calendar day
 *   node scripts/token-sinks.mjs --by model           # group by model
 *   node scripts/token-sinks.mjs --provider claude    # claude | codex | all (default all)
 *   node scripts/token-sinks.mjs --sort tokens        # cost (default) | tokens | output
 *   node scripts/token-sinks.mjs --top 30             # rows to show (default 20)
 *   node scripts/token-sinks.mjs --json               # machine-readable
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── pricing ────────────────────────────────────────────────────────────────
// $/1M tokens. cacheRead = 0.1x input, cacheWrite (5m) = 1.25x input.
const PRICING = [
  { match: /opus/, in: 5, out: 25 },
  { match: /sonnet/, in: 3, out: 15 },
  { match: /haiku/, in: 1, out: 5 },
];
function priceFor(model) {
  const p = PRICING.find((p) => p.match.test(model || ""));
  return p || { in: 5, out: 25 }; // default to opus pricing when unknown
}
function costUsd(model, t) {
  const p = priceFor(model);
  return (
    (t.input * p.in +
      t.output * p.out +
      t.cacheCreation * p.in * 1.25 +
      t.cacheRead * p.in * 0.1) /
    1_000_000
  );
}
const zeroTokens = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
function addTokens(a, b) {
  a.input += b.input;
  a.output += b.output;
  a.cacheCreation += b.cacheCreation;
  a.cacheRead += b.cacheRead;
}
const rawTotal = (t) => t.input + t.output + t.cacheCreation + t.cacheRead;

// ── parse one Claude transcript (assistant-turn usage) ───────────────────────
function parseClaude(path) {
  const tokens = zeroTokens();
  let model = "";
  let firstTs = "";
  let lastTs = "";
  let assistantTurns = 0;
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (obj.type !== "assistant") continue;
    const msg = obj.message;
    if (!msg) continue;
    if (msg.model && msg.model !== "<synthetic>") model = msg.model;
    const u = msg.usage;
    if (u) {
      assistantTurns++;
      tokens.input += u.input_tokens || 0;
      tokens.output += u.output_tokens || 0;
      tokens.cacheCreation += u.cache_creation_input_tokens || 0;
      tokens.cacheRead += u.cache_read_input_tokens || 0;
    }
  }
  return { tokens, model, firstTs, lastTs, assistantTurns };
}

// ── parse one Codex transcript (token_count events = cumulative; take last) ──
function parseCodex(path) {
  const tokens = zeroTokens();
  let model = "";
  let firstTs = "";
  let lastTs = "";
  let cwd = "";
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta" && p.cwd) cwd = p.cwd;
    if (obj.type === "turn_context" && p.model) model = p.model;
    if (obj.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      // cumulative — overwrite (last wins)
      tokens.input = t.input_tokens || 0;
      tokens.output = t.output_tokens || 0;
      tokens.cacheRead = t.cached_input_tokens || 0;
    }
  }
  return { tokens, model: model || "codex", firstTs, lastTs, cwd };
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
      if (st.mtimeMs < cutoffMs) continue; // stat-filter first
      const parsed = parseClaude(p);
      out.push({
        provider: "claude",
        sessionId: f.replace(/\.jsonl$/, ""),
        project: dir,
        path: p,
        modified: st.mtime,
        ...parsed,
      });
    }
  }
  return out;
}

function collectCodex(cutoffMs) {
  const base = join(homedir(), ".codex", "sessions");
  const out = [];
  if (!existsSync(base)) return out;
  // sessions/YYYY/MM/DD/*.jsonl — walk recursively
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
      out.push({
        provider: "codex",
        sessionId: e.name.replace(/\.jsonl$/, ""),
        project: parsed.cwd || "(unknown)",
        path: p,
        modified: st.mtime,
        ...parsed,
      });
    }
  };
  walk(base);
  return out;
}

// ── formatting ───────────────────────────────────────────────────────────────
function fmtTok(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
const fmtUsd = (n) => `$${n.toFixed(2)}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const days = parseInt(flag("days", "7"), 10);
const by = flag("by", "session"); // session | project | day | model | provider
const provider = flag("provider", "all"); // claude | codex | all
const sort = flag("sort", "cost"); // cost | tokens | output
const top = parseInt(flag("top", "20"), 10);
const jsonOut = args.includes("--json");

const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

let sessions = [];
if (provider === "all" || provider === "claude") sessions.push(...collectClaude(cutoffMs));
if (provider === "all" || provider === "codex") sessions.push(...collectCodex(cutoffMs));

// attach per-session cost (codex left at 0 — different provider/pricing)
for (const s of sessions) {
  s.cost = s.provider === "claude" ? costUsd(s.model, s.tokens) : 0;
  s.rawTokens = rawTotal(s.tokens);
}

// group
const keyOf = (s) => {
  switch (by) {
    case "project": return s.project;
    case "day": return (s.lastTs || s.modified.toISOString()).slice(0, 10);
    case "model": return s.model || "(unknown)";
    case "provider": return s.provider;
    default: return `${s.provider}:${s.sessionId.slice(0, 8)}`;
  }
};
const groups = new Map();
for (const s of sessions) {
  const k = keyOf(s);
  let g = groups.get(k);
  if (!g) {
    g = { key: k, tokens: zeroTokens(), cost: 0, sessions: 0, provider: s.provider, model: s.model, project: s.project };
    groups.set(k, g);
  }
  addTokens(g.tokens, s.tokens);
  g.cost += s.cost;
  g.sessions++;
  if (g.provider !== s.provider) g.provider = "mixed";
};

let rows = [...groups.values()].map((g) => ({ ...g, rawTokens: rawTotal(g.tokens) }));
const sortKey = sort === "tokens" ? (r) => r.rawTokens : sort === "output" ? (r) => r.tokens.output : (r) => r.cost;
rows.sort((a, b) => sortKey(b) - sortKey(a));

// totals
const totals = { tokens: zeroTokens(), cost: 0, sessions: sessions.length };
for (const s of sessions) { addTokens(totals.tokens, s.tokens); totals.cost += s.cost; }

if (jsonOut) {
  console.log(JSON.stringify({ days, by, provider, sort, totals, rows: rows.slice(0, top) }, null, 2));
  process.exit(0);
}

console.log("═".repeat(78));
console.log(`TOKEN SINKS — last ${days}d · grouped by ${by} · sorted by ${sort} · provider=${provider}`);
console.log("═".repeat(78));
console.log(
  `Sessions in window: ${totals.sessions}   ` +
  `Raw tokens: ${fmtTok(rawTotal(totals.tokens))}   ` +
  `Est. cost (claude): ${fmtUsd(totals.cost)}`,
);
console.log(
  `  in ${fmtTok(totals.tokens.input)} · out ${fmtTok(totals.tokens.output)} · ` +
  `cache-write ${fmtTok(totals.tokens.cacheCreation)} · cache-read ${fmtTok(totals.tokens.cacheRead)}`,
);
console.log("─".repeat(78));
const keyW = by === "project" ? 40 : 22;
console.log(
  `${pad(by, keyW)} ${padL("cost", 9)} ${padL("out", 8)} ${padL("in", 8)} ` +
  `${padL("cWrite", 8)} ${padL("cRead", 9)} ${padL("sess", 5)}`,
);
console.log("─".repeat(78));
for (const r of rows.slice(0, top)) {
  let label = r.key;
  if (by === "session") label = `${r.provider === "codex" ? "cx" : "cc"}:${r.key.split(":")[1]} ${(r.project.match(/ak-(\d+)/) || [, ""])[1] ? "#" + r.project.match(/ak-(\d+)/)[1] : ""}`.trim();
  console.log(
    `${pad(label, keyW)} ${padL(fmtUsd(r.cost), 9)} ${padL(fmtTok(r.tokens.output), 8)} ` +
    `${padL(fmtTok(r.tokens.input), 8)} ${padL(fmtTok(r.tokens.cacheCreation), 8)} ` +
    `${padL(fmtTok(r.tokens.cacheRead), 9)} ${padL(r.sessions, 5)}`,
  );
}
console.log("═".repeat(78));
console.log(
  "Note: cost = est. USD from per-model pricing (cache-read ~0.1x, cache-write ~1.25x).\n" +
  "      Codex sessions counted in raw tokens but not costed (different pricing).",
);
