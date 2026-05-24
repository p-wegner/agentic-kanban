#!/usr/bin/env node
/**
 * Analyze a Copilot CLI session events.jsonl file.
 *
 * Usage:
 *   node scripts/analyze-copilot-session.mjs <path-to-events.jsonl>
 *   node scripts/analyze-copilot-session.mjs --list
 *   node scripts/analyze-copilot-session.mjs --latest
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

function parseCopilotSession(lines) {
  const callNameMap = new Map();
  const stats = {
    sessionId: "",
    model: "",
    copilotVersion: "",
    cwd: "",
    branch: "",
    startTime: "",
    endTime: "",
    durationSec: 0,
    turns: 0,
    toolCalls: 0,
    toolNames: {},
    commands: [],
    userMessages: [],
    assistantMessages: [],
    hooks: 0,
    shutdownType: "",
    totalApiDurationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }

    const type = obj.type;
    const data = obj.data || {};
    const ts = obj.timestamp;

    if (ts && (!stats.endTime || ts > stats.endTime)) stats.endTime = ts;

    if (type === "session.start") {
      stats.sessionId = data.sessionId || "";
      stats.copilotVersion = data.copilotVersion || "";
      stats.cwd = data.context?.cwd || "";
      stats.branch = data.context?.branch || "";
      stats.startTime = data.startTime || ts || "";
    }
    else if (type === "session.model_change") {
      stats.model = data.newModel || stats.model;
    }
    else if (type === "user.message") {
      stats.userMessages.push(data.content || "");
    }
    else if (type === "assistant.turn_start") {
      stats.turns++;
    }
    else if (type === "assistant.message") {
      if (data.content) stats.assistantMessages.push(data.content);
      if (data.model && !stats.model) stats.model = data.model;
      if (data.toolRequests) {
        for (const tr of data.toolRequests) {
          stats.toolCalls++;
          stats.toolNames[tr.name] = (stats.toolNames[tr.name] || 0) + 1;
          callNameMap.set(tr.toolCallId, tr.name);
          if (tr.name === "shell" && tr.arguments?.command) {
            stats.commands.push(tr.arguments.command);
          }
        }
      }
    }
    else if (type === "tool.execution_start") {
      callNameMap.set(data.toolCallId, data.toolName);
    }
    else if (type === "tool.execution_complete") {
      // Count tool completions not already counted from assistant.message
    }
    else if (type === "hook.start") {
      stats.hooks++;
    }
    else if (type === "system.notification") {
      // Track for context
    }
    else if (type === "session.shutdown") {
      stats.shutdownType = data.shutdownType || "";
      stats.totalApiDurationMs = data.totalApiDurationMs || 0;
      stats.linesAdded = data.codeChanges?.linesAdded || 0;
      stats.linesRemoved = data.codeChanges?.linesRemoved || 0;
      stats.filesModified = data.codeChanges?.filesModified || [];
    }
  }

  if (stats.startTime) {
    const start = new Date(stats.startTime).getTime();
    const end = stats.endTime ? new Date(stats.endTime).getTime() : start;
    stats.durationSec = Math.round((end - start) / 1000);
  }

  return stats;
}

function formatDuration(sec) {
  if (!sec || sec < 0) return "?";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function printSummary({ stats }) {
  console.log("=".repeat(60));
  console.log("COPILOT SESSION SUMMARY");
  console.log("=".repeat(60));

  console.log(`\nSession:    ${stats.sessionId.slice(0, 8)}...`);
  console.log(`Model:      ${stats.model}`);
  console.log(`Copilot:    v${stats.copilotVersion}`);
  console.log(`CWD:        ${stats.cwd}`);
  console.log(`Branch:     ${stats.branch}`);
  console.log(`Duration:   ${formatDuration(stats.durationSec)} (API: ${formatDuration(Math.round(stats.totalApiDurationMs / 1000))})`);
  console.log(`Shutdown:   ${stats.shutdownType}`);
  console.log(`Turns:      ${stats.turns}`);
  console.log(`Tool calls: ${stats.toolCalls}`);
  if (stats.linesAdded || stats.linesRemoved) {
    console.log(`Changes:    +${stats.linesAdded}/-${stats.linesRemoved} lines in ${stats.filesModified.length} files`);
  }

  if (stats.userMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("USER MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.userMessages) {
      const truncated = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
      console.log(`  -> ${truncated}`);
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
      const truncated = cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
      console.log(`  $ ${truncated}`);
    }
  }

  if (stats.assistantMessages.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("AGENT MESSAGES");
    console.log("─".repeat(40));
    for (const msg of stats.assistantMessages) {
      const truncated = msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
      console.log(`  ${truncated}`);
      console.log();
    }
  }

  if (stats.filesModified.length) {
    console.log(`\n${"─".repeat(40)}`);
    console.log("FILES MODIFIED");
    console.log("─".repeat(40));
    for (const f of stats.filesModified) {
      console.log(`  ${f}`);
    }
  }

  console.log("=".repeat(60));
}

// ── Session Discovery ────────────────────────────────────────────────────

function findCopilotSessionsDir() {
  return join(homedir(), ".copilot", "session-state");
}

function listSessions(sessionsDir) {
  const sessions = [];
  try {
    const dirs = readdirSync(sessionsDir).filter(d => {
      const full = join(sessionsDir, d);
      return statSync(full).isDirectory() && existsSync(join(full, "workspace.yaml"));
    });
    for (const dir of dirs) {
      const fullPath = join(sessionsDir, dir);
      const eventsPath = join(fullPath, "events.jsonl");
      const hasEvents = existsSync(eventsPath);
      const eventsSize = hasEvents ? statSync(eventsPath).size : 0;
      const wsStat = statSync(fullPath);
      sessions.push({
        id: dir,
        path: fullPath,
        eventsPath: hasEvents ? eventsPath : null,
        hasEvents,
        eventsSize,
        modified: wsStat.mtime,
      });
    }
  } catch (e) {
    console.error(`Error reading sessions: ${e.message}`);
  }
  return sessions.sort((a, b) => b.modified - a.modified);
}

// ── Main ─────────────────────────────────────────────────────────────────

const arg = process.argv[2];
const sessionsDir = findCopilotSessionsDir();

if (!arg) {
  console.log("Usage: node analyze-copilot-session.mjs <path-to-events.jsonl>");
  console.log("       node analyze-copilot-session.mjs --list");
  console.log("       node analyze-copilot-session.mjs --latest");
  process.exit(1);
}

if (arg === "--list") {
  const sessions = listSessions(sessionsDir);
  console.log(`Found ${sessions.length} sessions in ${sessionsDir}\n`);
  for (const s of sessions.slice(0, 20)) {
    const date = s.modified.toISOString().slice(0, 16);
    const size = s.hasEvents ? `${(s.eventsSize / 1024).toFixed(0)}KB` : "(no events)";
    console.log(`  ${date}  ${size}  ${s.id}`);
  }
  process.exit(0);
}

let targetPath;
if (arg === "--latest") {
  const sessions = listSessions(sessionsDir).filter(s => s.hasEvents);
  if (!sessions.length) {
    console.error("No sessions with events.jsonl found.");
    process.exit(1);
  }
  targetPath = sessions[0].eventsPath;
  console.log(`Analyzing latest session: ${sessions[0].id}\n`);
} else {
  targetPath = resolve(arg);
}

const content = readFileSync(targetPath, "utf-8");
const lines = content.split("\n");
const stats = parseCopilotSession(lines);
printSummary({ stats });
