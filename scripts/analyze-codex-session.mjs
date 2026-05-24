#!/usr/bin/env node
/**
 * Analyze a Codex CLI session JSONL file.
 *
 * Usage:
 *   node scripts/analyze-codex-session.mjs <path-to-session.jsonl>
 *   node scripts/analyze-codex-session.mjs --list                   # list recent sessions
 *   node scripts/analyze-codex-session.mjs --latest                 # analyze most recent session
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ── Codex Session Parser (inline for standalone use) ─────────────────────

function parseCodexSession(lines) {
  const callNameMap = new Map();
  const stats = {
    model: "",
    sessionId: "",
    cwd: "",
    cliVersion: "",
    startTime: "",
    endTime: "",
    durationSec: 0,
    turns: 0,
    toolCalls: 0,
    toolNames: {},
    commands: [],
    userMessages: [],
    agentMessages: [],
    patchesApplied: [],
    webSearches: [],
    inputTokens: 0,
    outputTokens: 0,
  };
  const events = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const type = obj.type;
    const payload = obj.payload || {};
    const timestamp = obj.timestamp;

    if (timestamp) {
      if (!stats.startTime) stats.startTime = timestamp;
      stats.endTime = timestamp;
    }

    if (type === "session_meta") {
      stats.sessionId = payload.id || "";
      stats.cwd = payload.cwd || "";
      stats.cliVersion = payload.cli_version || "";
    }

    else if (type === "turn_context") {
      if (payload.model) stats.model = payload.model;
    }

    else if (type === "event_msg") {
      const msgType = payload.type;

      if (msgType === "user_message") {
        stats.userMessages.push(payload.message || "");
      }
      else if (msgType === "agent_message") {
        stats.agentMessages.push(payload.message || "");
      }
      else if (msgType === "task_started") {
        stats.turns++;
      }
      else if (msgType === "task_complete") {
        events.push({ type: "task_complete", message: payload.last_agent_message || "" });
      }
      else if (msgType === "token_count" && payload.info?.total_token_usage) {
        const t = payload.info.total_token_usage;
        stats.inputTokens = t.input_tokens || 0;
        stats.outputTokens = t.output_tokens || 0;
      }
      else if (msgType === "patch_apply_end") {
        const changes = payload.changes || {};
        const changedFiles = Object.keys(changes);
        const stdout = payload.stdout || "";
        stats.patchesApplied.push({ files: changedFiles, success: payload.success !== false, stdout });
      }
      else if (msgType === "web_search_end") {
        stats.webSearches.push(payload.query || "");
      }
    }

    else if (type === "response_item") {
      const riType = payload.type;

      if (riType === "function_call") {
        const name = payload.name || "";
        const callId = payload.call_id || "";
        callNameMap.set(callId, name);
        stats.toolCalls++;
        stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;

        let parsed = {};
        try { parsed = JSON.parse(payload.arguments || "{}"); } catch {}
        if (name === "shell_command" && parsed.command) {
          stats.commands.push(parsed.command);
        }
      }
      else if (riType === "custom_tool_call") {
        const name = payload.name || "custom_tool";
        const callId = payload.call_id || "";
        callNameMap.set(callId, name);
        stats.toolCalls++;
        stats.toolNames[name] = (stats.toolNames[name] || 0) + 1;
      }
    }
  }

  if (stats.startTime && stats.endTime) {
    stats.durationSec = Math.round((new Date(stats.endTime) - new Date(stats.startTime)) / 1000);
  }

  return { events, stats };
}

// ── Formatters ───────────────────────────────────────────────────────────

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function printSummary({ stats }) {
  console.log("═".repeat(60));
  console.log("CODEX SESSION SUMMARY");
  console.log("═".repeat(60));

  console.log(`\nSession:    ${stats.sessionId.slice(0, 8)}…`);
  console.log(`Model:      ${stats.model}`);
  console.log(`CWD:        ${stats.cwd}`);
  console.log(`CLI:        v${stats.cliVersion}`);
  console.log(`Duration:   ${formatDuration(stats.durationSec)}`);
  console.log(`Turns:      ${stats.turns}`);
  console.log(`Tokens:     ${formatTokens(stats.inputTokens)} in / ${formatTokens(stats.outputTokens)} out`);

  if (stats.userMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("USER MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.userMessages) {
      const truncated = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
      console.log(`  → ${truncated}`);
    }
  }

  if (stats.toolCalls) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("TOOL USAGE");
    console.log("─".repeat(40));
    const sorted = Object.entries(stats.toolNames).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`  ${name}: ${count} calls`);
    }
  }

  if (stats.commands.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("COMMANDS RUN");
    console.log("─".repeat(40));
    for (const cmd of stats.commands) {
      const truncated = cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd;
      console.log(`  $ ${truncated}`);
    }
  }

  if (stats.webSearches.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("WEB SEARCHES");
    console.log("─".repeat(40));
    for (const q of stats.webSearches) {
      console.log(`  🔍 ${q}`);
    }
  }

  if (stats.patchesApplied.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("PATCHES APPLIED");
    console.log("─".repeat(40));
    for (const patch of stats.patchesApplied) {
      const status = patch.success ? "✓" : "✗";
      for (const f of patch.files) {
        console.log(`  ${status} ${f.replace(/^.*[\\/]packages/, "packages")}`);
      }
    }
  }

  if (stats.agentMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("AGENT MESSAGES (last 5)");
    console.log("─".repeat(40));
    const last5 = stats.agentMessages.slice(-5);
    for (const msg of last5) {
      const truncated = msg.length > 300 ? msg.slice(0, 300) + "…" : msg;
      console.log(`  ${truncated}`);
      console.log();
    }
  }

  console.log("═".repeat(60));
}

// ── Session Discovery ────────────────────────────────────────────────────

function findCodexSessionsDir() {
  return join(homedir(), ".codex", "sessions");
}

function listSessions(sessionsDir) {
  const sessions = [];
  try {
    const years = readdirSync(sessionsDir).filter(d => /^\d{4}$/.test(d)).sort().reverse();
    for (const year of years) {
      const monthsDir = join(sessionsDir, year);
      const months = readdirSync(monthsDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
      for (const month of months) {
        const daysDir = join(monthsDir, month);
        const days = readdirSync(daysDir).filter(d => /^\d{2}$/.test(d)).sort().reverse();
        for (const day of days) {
          const filesDir = join(daysDir, day);
          const files = readdirSync(filesDir).filter(f => f.endsWith(".jsonl"));
          for (const file of files) {
            const filePath = join(filesDir, file);
            const stat = statSync(filePath);
            sessions.push({ path: filePath, name: file, size: stat.size, modified: stat.mtime });
          }
        }
      }
    }
  } catch (e) {
    console.error(`Error reading sessions: ${e.message}`);
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

// ── Main ─────────────────────────────────────────────────────────────────

const arg = process.argv[2];
const sessionsDir = findCodexSessionsDir();

if (!arg) {
  console.log("Usage: node analyze-codex-session.mjs <path-to-session.jsonl>");
  console.log("       node analyze-codex-session.mjs --list");
  console.log("       node analyze-codex-session.mjs --latest");
  process.exit(1);
}

if (arg === "--list") {
  const sessions = listSessions(sessionsDir);
  console.log(`Found ${sessions.length} sessions in ${sessionsDir}\n`);
  for (const s of sessions.slice(0, 20)) {
    const sizeKB = (s.size / 1024).toFixed(0);
    const date = s.modified.toISOString().slice(0, 16);
    console.log(`  ${date}  ${sizeKB}KB  ${s.name.slice(0, 60)}…`);
  }
  process.exit(0);
}

let targetPath;
if (arg === "--latest") {
  const sessions = listSessions(sessionsDir);
  if (!sessions.length) {
    console.error("No sessions found.");
    process.exit(1);
  }
  targetPath = sessions[0].path;
  console.log(`Analyzing latest session: ${sessions[0].name}\n`);
} else {
  targetPath = resolve(arg);
}

const content = readFileSync(targetPath, "utf-8");
const lines = content.split("\n");
const result = parseCodexSession(lines);
printSummary(result);
