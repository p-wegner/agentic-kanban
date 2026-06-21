#!/usr/bin/env node
/**
 * For a given failure signature, find every occurrence across Claude sessions
 * in a window and analyze WHAT THE AGENT DID NEXT — does it recover correctly,
 * misdiagnose, retry blindly, or give up? Answers "what do agents typically do
 * when they hit error X" empirically instead of by anecdote.
 *
 * Companion to tool-failures.mjs (which counts/clusters failures); this one
 * looks at the *next assistant turn* after each failure and classifies recovery.
 *
 * Claude only (the next-turn text+tool structure is clean there). Codex's
 * shell-only turns carry less recovery signal.
 *
 * Usage:
 *   node scripts/analyze-failure-recovery.mjs                 # default: worktree-test cluster, 7d
 *   node scripts/analyze-failure-recovery.mjs --match "could not find vitest|No test files found|UNRESOLVED_IMPORT"
 *   node scripts/analyze-failure-recovery.mjs --days 14 --examples 8
 *   node scripts/analyze-failure-recovery.mjs --json
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const days = parseInt(flag("days", "7"), 10);
const matchRe = new RegExp(flag("match", "could not find vitest|No test files found|UNRESOLVED_IMPORT|Cannot find module 'react'"), "i");
const nExamples = parseInt(flag("examples", "10"), 10);
const jsonOut = args.includes("--json");
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

const cmdOf = (input) => input?.command || input?.cmd || input?.script || "";
const snip = (s, n = 160) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

// classify the agent's next move after the failure
function classify(next) {
  const c = (next.cmd || "").toLowerCase();
  const t = (next.text || "").toLowerCase();
  const tool = next.tool || "";
  if (/pnpm\s+(install|i)\b|pnpm i\b/.test(c)) return "pnpm install (fix deps)";
  if (/vitest\s+related|exec vitest related|test:mine.*--changed/.test(c)) return "narrow re-run (related)";
  if (/pnpm\s+(run\s+)?(test|test:mine)\b|\bvitest\b|pnpm exec vitest/.test(c)) return "re-run test (blind retry)";
  if ((/\bcd\b/.test(c) && /agentic-kanban/.test(c) && !/worktree/.test(c)) || /main checkout/.test(t)) return "relocate to main checkout";
  if (/pnpm\s+dev|vite\b|playwright|dev server/.test(c) || /dev server|playwright/.test(t)) return "switch to dev/e2e verify";
  if ((tool === "Read" || tool === "Grep" || tool === "Glob") && /test|spec|\.test\.|describe\(/.test(c + " " + JSON.stringify(next.input || {}))) return "hunt for test files (misdiagnose)";
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return "inspect files/code";
  if (tool === "Edit" || tool === "Write") return "edit code/tests";
  if (/skip|without running|move on|unable to run|can'?t run|couldn'?t run|no tests/.test(t)) return "abandon / skip tests";
  if (!tool && next.text) return "explain / no further tool";
  return "other";
}

function collectClaude() {
  const base = join(homedir(), ".claude", "projects");
  const occ = [];
  if (!existsSync(base)) return occ;
  for (const dir of readdirSync(base)) {
    const dp = join(base, dir);
    let files;
    try { files = readdirSync(dp); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dp, f);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.mtimeMs < cutoffMs) continue;

      // build an ordered list of entries; map tool_use id -> {name, cmd}
      const entries = [];
      const toolById = new Map();
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        const s = line.trim(); if (!s) continue;
        let o; try { o = JSON.parse(s); } catch { continue; }
        if (o.type === "assistant" || o.type === "user") entries.push(o);
        if (o.type === "assistant") for (const b of o.message?.content || []) {
          if (b.type === "tool_use") toolById.set(b.id, { name: b.name, cmd: cmdOf(b.input) });
        }
      }
      // scan for failing tool_results matching the signature
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.type !== "user" || !Array.isArray(e.message?.content)) continue;
        for (const b of e.message.content) {
          if (b.type !== "tool_result" || !b.is_error) continue;
          const txt = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join(" ") : String(b.content || "");
          if (!matchRe.test(txt)) continue;
          const failedTool = toolById.get(b.tool_use_id) || {};
          // find next assistant turn
          const next = { text: "", tool: "", cmd: "", input: null };
          for (let j = i + 1; j < entries.length; j++) {
            if (entries[j].type !== "assistant") continue;
            for (const nb of entries[j].message?.content || []) {
              if (nb.type === "text" && nb.text && !next.text) next.text = nb.text;
              if (nb.type === "tool_use" && !next.tool) { next.tool = nb.name; next.cmd = cmdOf(nb.input); next.input = nb.input; }
            }
            break;
          }
          occ.push({
            project: dir,
            failedCmd: snip(failedTool.cmd, 80),
            error: snip(txt, 120),
            next,
            category: classify(next),
          });
        }
      }
    }
  }
  return occ;
}

const occ = collectClaude();
const byCat = new Map();
for (const o of occ) byCat.set(o.category, (byCat.get(o.category) || 0) + 1);
const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);

if (jsonOut) {
  console.log(JSON.stringify({ days, pattern: matchRe.source, total: occ.length, categories: cats, examples: occ.slice(0, nExamples) }, null, 2));
  process.exit(0);
}

console.log("═".repeat(78));
console.log(`FAILURE RECOVERY — last ${days}d · Claude · what agents do AFTER the failure`);
console.log(`pattern: /${matchRe.source}/i`);
console.log("═".repeat(78));
console.log(`Matched failure occurrences: ${occ.length}`);
console.log("─".repeat(78));
console.log("NEXT-TURN ACTION (the recovery move)                          count    share");
console.log("─".repeat(78));
for (const [cat, n] of cats) {
  console.log(`  ${cat.padEnd(52)} ${String(n).padStart(5)}   ${occ.length ? Math.round((100 * n) / occ.length) : 0}%`);
}
console.log("─".repeat(78));
console.log(`SAMPLE RECOVERIES (failed cmd → next move):`);
console.log("─".repeat(78));
for (const o of occ.slice(0, nExamples)) {
  const proj = (o.project.match(/ak-(\d+)/) || [undefined, ""])[1];
  console.log(`\n[${o.category}]${proj ? "  #" + proj : ""}`);
  console.log(`  failed:  ${o.failedCmd}`);
  console.log(`  error:   ${o.error}`);
  console.log(`  next:    ${o.next.tool || "(text)"}${o.next.cmd ? "  " + snip(o.next.cmd, 70) : ""}`);
  if (o.next.text) console.log(`  said:    ${snip(o.next.text, 140)}`);
}
console.log("\n" + "═".repeat(78));
console.log("Recovery = the next assistant turn after the failing tool_result.\n" +
  "'blind retry' / 'hunt for test files' / 'edit code' = misdiagnosis; 'pnpm install' /\n" +
  "'relocate to main' / 'narrow re-run' / 'dev verify' = correct root-cause recovery.");
