#!/usr/bin/env node
// candidates.mjs — map each capability (from a domain _plan.json) to its candidate test set,
// deterministically, using the test-inventory. This is the Phase-1 anchor: a test is a
// candidate for a capability when it EXERCISES the capability's source — matched by
// import basename (a unit test importing the module's files), api-path, or file-path keyword —
// NOT by slug keyword alone (which silently misses unit tests like merge-cascade.test.ts).
//
// Usage: node candidates.mjs <plan.json> <test-index.json> > _candidates.json
// Output: { slug: { name, source_basenames, candidates: [ {file, why:[...]} ] } }

import { readFileSync } from "node:fs";

const [planPath, indexPath] = process.argv.slice(2);
if (!planPath || !indexPath) {
  console.error("usage: candidates.mjs <plan.json> <test-index.json>");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const index = JSON.parse(readFileSync(indexPath, "utf8"));

const baseOf = (p) => p.replace(/\.[jt]sx?$/, "").split("/").pop();
// keywords per slug to catch file-path / api-path matches the import graph misses
const KEYWORDS = {
  "issues-board": ["issue", "board", "tag", "label", "priority"],
  workspaces: ["workspace", "worktree"],
  "agent-providers": ["provider", "agent-settings", "claude", "codex", "copilot", "pi-provider"],
  "agent-sessions": ["session", "agent.service", "stream", "output"],
  "workflow-engine": ["workflow", "status", "transition"],
  "monitor-orchestration": ["monitor", "conductor", "autopilot", "start-policy", "auto-start"],
  "review-merge": ["review", "merge", "diff"],
  butler: ["butler"],
  "git-integration": ["git", "worktree", "diff", "branch"],
  "mcp-server": ["mcp", "tool"],
  "persistence-schema": ["schema", "migration", "drizzle", "repository", "db"],
  "board-ui": ["panel", "view", "board", "component", "tsx"],
  "preferences-config": ["preference", "settings", "config", "pref"],
  "project-registration": ["project", "register", "stack-profile", "setup"],
  codemods: ["codemod", "transform"],
};

const result = {};
for (const m of plan.modules) {
  const srcBasenames = new Set((m.files || []).map(baseOf));
  const kws = KEYWORDS[m.slug] || [m.slug.split("-")[0]];
  const candidates = [];
  for (const f of index.files) {
    const why = [];
    // (c) source-import match — the high-signal one
    const importedSrc = (f.import_basenames || []).filter((b) => srcBasenames.has(b));
    if (importedSrc.length) why.push(`imports:${importedSrc.slice(0, 4).join(",")}`);
    // (a) api-path match
    const apiHit = (f.api_paths || []).some((p) => kws.some((k) => p.toLowerCase().includes(k)));
    if (apiHit) why.push("api-path");
    // file-path keyword (weaker, last resort)
    const pathHit = kws.some((k) => f.file.toLowerCase().includes(k));
    if (pathHit && !why.length) why.push("file-keyword");
    if (why.length) candidates.push({ file: f.file, titles: f.titles.length, why });
  }
  // rank: import matches first, then api, then keyword-only
  candidates.sort((a, b) => score(b) - score(a));
  result[m.slug] = {
    name: m.name,
    source_basenames: [...srcBasenames],
    candidate_count: candidates.length,
    candidates,
  };
}
function score(c) {
  return (c.why.some((w) => w.startsWith("imports")) ? 100 : 0) +
    (c.why.includes("api-path") ? 10 : 0) + c.titles;
}

process.stdout.write(JSON.stringify(result, null, 2) + "\n");
