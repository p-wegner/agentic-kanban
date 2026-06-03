#!/usr/bin/env node
/**
 * Analyze a Claude Code session JSONL transcript (~/.claude/projects/<dir>/<uuid>.jsonl).
 *
 * Parity with analyze-codex-session.mjs / analyze-copilot-session.mjs, plus the
 * friction metrics the fleet-analysis workflow cares about: tool-call counts,
 * FAILED tool calls (per tool), repeated commands, and error excerpts.
 *
 * Usage:
 *   node scripts/analyze-claude-session.mjs <path-to-session.jsonl>
 *   node scripts/analyze-claude-session.mjs --list [--worktrees]
 *   node scripts/analyze-claude-session.mjs --latest
 *   node scripts/analyze-claude-session.mjs --json <path>   # machine-readable
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

function parseClaudeSession(lines) {
  const toolNameById = new Map();
  const toolCounts = new Map(); // name -> { count, failed }
  const commandCounts = new Map();
  const stats = {
    model: "",
    sessionId: "",
    cwd: "",
    startTime: "",
    endTime: "",
    durationSec: 0,
    assistantTurns: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: 0,
    stopReason: "",
    userMessages: [],
    assistantTexts: [],
    errors: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    if (obj.timestamp) {
      if (!stats.startTime) stats.startTime = obj.timestamp;
      stats.endTime = obj.timestamp;
    }
    if (obj.sessionId && !stats.sessionId) stats.sessionId = obj.sessionId;
    if (obj.cwd && !stats.cwd) stats.cwd = obj.cwd;

    // Stream-json result event (rare in project transcripts, present in --print runs)
    if (obj.type === "result") {
      if (typeof obj.total_cost_usd === "number") stats.totalCostUsd = obj.total_cost_usd;
      continue;
    }

    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === "assistant") {
      stats.assistantTurns++;
      if (msg.model) stats.model = msg.model;
      if (msg.stop_reason) stats.stopReason = msg.stop_reason;
      const u = msg.usage;
      if (u) {
        stats.inputTokens += u.input_tokens || 0;
        stats.outputTokens += u.output_tokens || 0;
        stats.cacheReadTokens += u.cache_read_input_tokens || 0;
      }
      for (const block of msg.content || []) {
        if (block.type === "text" && block.text) {
          stats.assistantTexts.push(block.text);
        } else if (block.type === "tool_use") {
          stats.toolCalls++;
          const name = block.name || "unknown";
          toolNameById.set(block.id, name);
          const e = toolCounts.get(name) || { count: 0, failed: 0 };
          e.count++;
          toolCounts.set(name, e);
          const cmd = block.input?.command || block.input?.cmd || block.input?.script;
          if (typeof cmd === "string") {
            const key = cmd.slice(0, 100);
            commandCounts.set(key, (commandCounts.get(key) || 0) + 1);
          }
        }
      }
    } else if (obj.type === "user") {
      const content = msg.content;
      if (typeof content === "string") {
        stats.userMessages.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            if (block.is_error) {
              stats.failedToolCalls++;
              const name = toolNameById.get(block.tool_use_id);
              if (name) {
                const e = toolCounts.get(name) || { count: 0, failed: 0 };
                e.failed++;
                toolCounts.set(name, e);
              }
              const text = Array.isArray(block.content)
                ? block.content.map((c) => c.text || "").join(" ")
                : String(block.content || "");
              if (text) stats.errors.push(text.slice(0, 200));
            }
          } else if (block.type === "text" && block.text) {
            stats.userMessages.push(block.text);
          }
        }
      }
    }
  }

  if (stats.startTime && stats.endTime) {
    stats.durationSec = Math.round((new Date(stats.endTime) - new Date(stats.startTime)) / 1000);
  }

  stats.toolNames = Object.fromEntries([...toolCounts.entries()].map(([k, v]) => [k, v]));
  stats.repeatedCommands = [...commandCounts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([command, count]) => ({ command, count }));

  return stats;
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function printSummary(s) {
  console.log("═".repeat(60));
  console.log("CLAUDE SESSION SUMMARY");
  console.log("═".repeat(60));
  console.log(`\nSession:    ${(s.sessionId || "?").slice(0, 8)}…`);
  console.log(`Model:      ${s.model}`);
  console.log(`CWD:        ${s.cwd}`);
  console.log(`Duration:   ${fmtDuration(s.durationSec)}`);
  console.log(`Asst turns: ${s.assistantTurns}`);
  console.log(`Tokens:     ${fmtTokens(s.inputTokens)} in / ${fmtTokens(s.outputTokens)} out / ${fmtTokens(s.cacheReadTokens)} cache-read`);
  console.log(`Tool calls: ${s.toolCalls}  (failed: ${s.failedToolCalls}${s.toolCalls ? `, ${Math.round((100 * s.failedToolCalls) / s.toolCalls)}%` : ""})`);
  console.log(`Stop:       ${s.stopReason || "(none / interrupted)"}`);

  const tools = Object.entries(s.toolNames).sort((a, b) => b[1].count - a[1].count);
  if (tools.length) {
    console.log(`\n${"─".repeat(40)}\nTOOL USAGE (failed/total)\n${"─".repeat(40)}`);
    for (const [name, { count, failed }] of tools) {
      console.log(`  ${name}: ${failed}/${count}${failed ? "  ⚠" : ""}`);
    }
  }
  if (s.repeatedCommands.length) {
    console.log(`\n${"─".repeat(40)}\nREPEATED COMMANDS (wasted-turn signal)\n${"─".repeat(40)}`);
    for (const { command, count } of s.repeatedCommands.slice(0, 10)) {
      console.log(`  ${count}×  ${command}`);
    }
  }
  if (s.errors.length) {
    console.log(`\n${"─".repeat(40)}\nERROR EXCERPTS (${s.errors.length})\n${"─".repeat(40)}`);
    for (const e of s.errors.slice(0, 5)) console.log(`  ✗ ${e.replace(/\s+/g, " ")}`);
  }
  if (s.assistantTexts.length) {
    console.log(`\n${"─".repeat(40)}\nLAST ASSISTANT MESSAGE\n${"─".repeat(40)}`);
    const last = s.assistantTexts[s.assistantTexts.length - 1];
    console.log(`  ${last.slice(0, 400)}${last.length > 400 ? "…" : ""}`);
  }
  console.log("═".repeat(60));
}

function listSessions(onlyWorktrees) {
  const base = join(homedir(), ".claude", "projects");
  const out = [];
  if (!existsSync(base)) return out;
  for (const dir of readdirSync(base)) {
    if (onlyWorktrees && !/worktrees-feature-ak-/.test(dir)) continue;
    const dirPath = join(base, dir);
    let files;
    try { files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const p = join(dirPath, f);
      const st = statSync(p);
      out.push({ path: p, name: f, dir, size: st.size, modified: st.mtime });
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const arg = args.find((a) => !a.startsWith("--"));

if (args.includes("--list")) {
  const sessions = listSessions(args.includes("--worktrees"));
  console.log(`Found ${sessions.length} Claude sessions\n`);
  for (const s of sessions.slice(0, 25)) {
    console.log(`  ${s.modified.toISOString().slice(0, 16)}  ${(s.size / 1024).toFixed(0)}KB  ${s.dir.slice(0, 50)}  ${s.name.slice(0, 12)}`);
  }
  process.exit(0);
}

let targetPath;
if (args.includes("--latest")) {
  const sessions = listSessions(false);
  if (!sessions.length) { console.error("No sessions found."); process.exit(1); }
  targetPath = sessions[0].path;
} else if (arg) {
  targetPath = resolve(arg);
} else {
  console.log("Usage: node analyze-claude-session.mjs <path.jsonl> | --list [--worktrees] | --latest [--json]");
  process.exit(1);
}

const stats = parseClaudeSession(readFileSync(targetPath, "utf-8").split("\n"));
if (jsonOut) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  printSummary(stats);
}
