#!/usr/bin/env node
/**
 * Regenerate the bundled `agentic-kanban` agent skill from source.
 *
 * The skill is what an agent on ANY machine reads to learn what this board can do, so its
 * feature lists must not be hand-maintained prose that drifts one release behind the code.
 * Everything enumerable — MCP tools, CLI commands, board views, keyboard shortcuts — is
 * extracted from the source of truth here and written into marked blocks; the prose around
 * those blocks is hand-written and never touched.
 *
 *   node packages/server/scripts/generate-bundled-skill.mjs           # write
 *   node packages/server/scripts/generate-bundled-skill.mjs --check   # exit 1 if stale
 *
 * Extraction is deliberately static (read + regex). Importing the CLI's own modules would
 * be more exact, but they pull in `db/index.ts`, which resolves — and can CREATE — a stub
 * database as an import side effect. A generator must never touch the DB.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PKG = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SERVER_PKG, "../..");
const SKILL_DIR = path.join(SERVER_PKG, "skills", "agentic-kanban");
const REFS_DIR = path.join(SKILL_DIR, "references");

const CHECK = process.argv.includes("--check");

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8").replace(/\r\n/g, "\n");

function headSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT, encoding: "utf-8", windowsHide: true,
    }).trim();
  } catch {
    return "unknown";
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────

/** MCP tools + their category labels, from the shared definition table. */
function extractMcpTools() {
  const src = read("packages/shared/src/lib/mcp-tool-definitions.ts");
  const categories = [];
  const catRe = /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g;
  for (let m; (m = catRe.exec(src)); ) categories.push({ id: m[1], label: m[2] });

  const tools = [];
  const toolRe = /\{\s*name:\s*"([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)",\s*category:\s*"([^"]+)"\s*\}/g;
  for (let m; (m = toolRe.exec(src)); ) {
    tools.push({ name: m[1], description: m[2].replace(/\\"/g, '"'), category: m[3] });
  }
  if (!tools.length) throw new Error("extractMcpTools: matched no tools — the definition table's shape changed");
  return { categories, tools };
}

/** First sentence of a commander `.description("…")`, which is often a multi-paragraph help text. */
function firstSentence(raw) {
  const text = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"').split("\n\n")[0].trim();
  const stop = text.search(/\.(\s|$)/);
  return (stop === -1 ? text : text.slice(0, stop)).trim();
}

/**
 * CLI groups and their subcommands, from `packages/server/src/cli/commands/*.ts`.
 *
 * Every command file follows one shape: `const <x>Cmd = program.command("<group>")` declares
 * a group, `<x>Cmd.command("<sub> <args>")` adds a leaf, and a bare `program.command("<name>")`
 * with no assignment is a top-level command. Matches are walked in source order because a
 * receiver only resolves once its own declaration has been seen — that also makes nesting
 * (`issue dependency add`) fall out for free.
 */
function extractCliCommands() {
  const dir = path.join(REPO_ROOT, "packages/server/src/cli/commands");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();

  const groups = new Map();   // group path ("issue dependency") → { name, description, subs }
  const topLevel = [];

  // Receiver variable → group path, shared ACROSS files: a nested group can be registered from
  // another module that takes the parent as a parameter (`registerIssueDependencyCommands(issueCmd)`),
  // so `issueCmd` must still resolve to "issue" there. Two passes settle the cross-file order.
  const varToGroup = new Map();

  const scan = (file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf-8").replace(/\r\n/g, "\n");

    const re = /(\w+)\s*(?:\n\s*)?\.command\("([^"]+)"\)/g;
    const hits = [];
    for (let m; (m = re.exec(src)); ) hits.push({ receiver: m[1], spec: m[2], at: m.index, end: re.lastIndex });

    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const label = hit.spec.split(" ")[0];
      const parent = hit.receiver === "program" ? "" : varToGroup.get(hit.receiver);
      if (parent === undefined) continue;   // receiver is not a command builder (a fetch chain, etc.)

      // The first `.description("…")` before the next `.command(` belongs to this command.
      const slice = src.slice(hit.end, i + 1 < hits.length ? hits[i + 1].at : src.length);
      const descMatch = /\.description\(\s*"((?:[^"\\]|\\.)*)"/.exec(slice);
      const description = descMatch ? firstSentence(descMatch[1]) : "";

      const assign = /const\s+(\w+)\s*=\s*$/.exec(src.slice(Math.max(0, hit.at - 60), hit.at));
      if (assign) {
        const groupPath = parent ? `${parent} ${label}` : label;
        varToGroup.set(assign[1], groupPath);
        const existing = groups.get(groupPath);
        if (existing) { if (!existing.description) existing.description = description; }
        else groups.set(groupPath, { name: groupPath, description, subs: [] });
        continue;
      }

      if (!parent) {
        if (!topLevel.some(c => c.name === hit.spec)) topLevel.push({ name: hit.spec, description });
        continue;
      }
      const group = groups.get(parent);
      if (group && !group.subs.some(s => s.name === hit.spec)) group.subs.push({ name: hit.spec, description });
    }
  };

  for (const file of files) scan(file);
  for (const file of files) scan(file);

  // A group that only ever nests other groups (no leaf subcommands) would render as an empty row.
  const ordered = [...groups.values()].filter(g => g.subs.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  topLevel.sort((a, b) => a.name.localeCompare(b.name));
  if (ordered.length < 5) throw new Error(`extractCliCommands: found only ${ordered.length} command groups — the CLI's shape changed`);
  return { groups: ordered, topLevel };
}

/** Board views with their view-switch shortcut. */
function extractViews() {
  const src = read("packages/client/src/lib/viewRegistry.tsx");
  const views = [];
  for (const block of src.split(/\{\s*\n/)) {
    const id = /^\s*id:\s*"([^"]+)"/m.exec(block);
    const label = /^\s*label:\s*"([^"]+)"/m.exec(block);
    const shortcut = /^\s*shortcut:\s*"([^"]+)"/m.exec(block);
    if (id && label && shortcut) views.push({ id: id[1], label: label[1], shortcut: shortcut[1] });
  }
  return views;
}

/** Keyboard shortcuts grouped by their declared category. */
function extractShortcuts() {
  const src = read("packages/client/src/lib/shortcutRegistry.ts");
  const out = [];
  const re = /\{\s*keys:\s*\[([^\]]+)\],\s*description:\s*"((?:[^"\\]|\\.)*)",\s*category:\s*"([^"]+)"(?:,\s*sequential:\s*true)?\s*\}/g;
  const isMod = k => k === "Shift" || k === "Ctrl" || k === "Alt" || k === "Meta";
  for (let m; (m = re.exec(src)); ) {
    const keys = m[1].replace(/"/g, "").split(",").map(k => k.trim()).filter(Boolean);
    const parts = [];
    for (let i = 0; i < keys.length; i++) {
      if (isMod(keys[i])) {
        let combo = keys[i];
        while (i + 1 < keys.length && isMod(keys[i + 1])) combo += "+" + keys[++i];
        if (i + 1 < keys.length) combo += "+" + keys[++i];
        parts.push(combo);
      } else {
        const alts = [];
        while (i < keys.length && !isMod(keys[i])) alts.push(keys[i++]);
        i--;
        parts.push(alts.join("/"));
      }
    }
    out.push({ keys: parts.join(", "), description: m[2].replace(/\\"/g, '"'), category: m[3] });
  }
  return out;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const GENERATED_HEADER =
  "<!-- Generated by packages/server/scripts/generate-bundled-skill.mjs — do not edit by hand. -->";

const cell = (s) => s.replace(/\|/g, "\\|");

function renderMcpIndex({ categories, tools }) {
  const lines = [
    "## MCP tool index", "",
    `${tools.length} tools, by category. Full descriptions: \`references/mcp-tools.md\`.`, "",
    "| Category | Tools |", "|---|---|",
  ];
  for (const cat of categories) {
    const names = tools.filter(t => t.category === cat.id).map(t => `\`${t.name}\``);
    if (names.length) lines.push(`| ${cat.label} | ${names.join(", ")} |`);
  }
  return lines.join("\n");
}

function renderCliIndex({ groups, topLevel }) {
  const lines = [
    "## CLI index", "",
    "`agentic-kanban <command>` (inside this repo: `pnpm cli -- <command>`). Full list with descriptions: `references/cli.md`.", "",
    "Top-level: " + topLevel.map(c => `\`${c.name.split(" ")[0]}\``).join(", "), "",
    "| Group | Subcommands |", "|---|---|",
  ];
  for (const g of groups) {
    lines.push(`| \`${g.name}\` | ${g.subs.map(s => `\`${s.name.split(" ")[0]}\``).join(", ")} |`);
  }
  return lines.join("\n");
}

function renderMcpReference({ categories, tools }) {
  const lines = [
    GENERATED_HEADER, "", "# MCP tools", "",
    `All ${tools.length} tools exposed by the \`agentic-kanban\` MCP server. Call them as \`mcp__agentic-kanban__<name>\`.`, "",
  ];
  for (const cat of categories) {
    const inCat = tools.filter(t => t.category === cat.id);
    if (!inCat.length) continue;
    lines.push(`## ${cat.label}`, "", "| Tool | Does |", "|---|---|");
    for (const t of inCat) lines.push(`| \`${t.name}\` | ${cell(t.description)} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderCliReference({ groups, topLevel }) {
  const lines = [
    GENERATED_HEADER, "", "# CLI reference", "",
    "Invoke as `agentic-kanban <command>`; inside a checkout of this repo, `pnpm cli -- <command>`.",
    "Run any command with `--help` for its options — this list is names and purpose only.", "",
    "## Top-level", "", "| Command | Does |", "|---|---|",
  ];
  for (const c of topLevel) lines.push(`| \`${c.name}\` | ${cell(c.description)} |`);
  lines.push("");
  for (const g of groups) {
    lines.push(`## ${g.name}`, "");
    if (g.description) lines.push(g.description + ".", "");
    lines.push("| Command | Does |", "|---|---|");
    for (const s of g.subs) lines.push(`| \`${g.name} ${s.name}\` | ${cell(s.description)} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function renderViewsReference(views, shortcuts) {
  const lines = [
    GENERATED_HEADER, "", "# Board views and keyboard shortcuts", "",
    "## Views", "", "| View | Key | Id |", "|---|---|---|",
  ];
  for (const v of views) lines.push(`| ${v.label} | \`${v.shortcut}\` | \`${v.id}\` |`);
  lines.push("");
  for (const cat of [...new Set(shortcuts.map(s => s.category))]) {
    lines.push(`## ${cat}`, "", "| Keys | Does |", "|---|---|");
    for (const s of shortcuts.filter(s => s.category === cat)) lines.push(`| \`${s.keys}\` | ${cell(s.description)} |`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Replace the body of a `<!-- GENERATED:<id> … -->` block, leaving its markers in place. */
function replaceBlock(content, id, body) {
  const re = new RegExp(`(<!-- GENERATED:${id}[^>]*-->)[\\s\\S]*?(<!-- /GENERATED:${id} -->)`);
  if (!re.test(content)) throw new Error(`SKILL.md has no GENERATED:${id} block`);
  return content.replace(re, `$1\n\n${body}\n\n$2`);
}

function buildSkillMd(previous, data) {
  let out = previous.replace(/\r\n/g, "\n");
  out = replaceBlock(out, "mcp-index", renderMcpIndex(data.mcp));
  out = replaceBlock(out, "cli-index", renderCliIndex(data.cli));
  out = out.replace(/^commit:.*$/m, `commit: ${data.sha}`);
  out = out.replace(/^generated:.*$/m, `generated: ${data.date}`);
  return out;
}

/**
 * Content identity used by `--check`: the stamp lines change on every run (and on every
 * commit), so comparing them would make the check fire for reasons unrelated to drift.
 */
const withoutStamp = (s) => s.replace(/\r\n/g, "\n").replace(/^(commit|generated):.*$/gm, "");

// ── Main ──────────────────────────────────────────────────────────────────────

const mcp = extractMcpTools();
const cli = extractCliCommands();
const views = extractViews();
const shortcuts = extractShortcuts();

const skillPath = path.join(SKILL_DIR, "SKILL.md");
const targets = [
  [skillPath, buildSkillMd(fs.readFileSync(skillPath, "utf-8"), {
    mcp, cli, sha: headSha(), date: new Date().toISOString().slice(0, 10),
  })],
  [path.join(REFS_DIR, "mcp-tools.md"), renderMcpReference(mcp)],
  [path.join(REFS_DIR, "cli.md"), renderCliReference(cli)],
  [path.join(REFS_DIR, "views-and-shortcuts.md"), renderViewsReference(views, shortcuts)],
];

const stale = [];
for (const [file, next] of targets) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  if (withoutStamp(current) !== withoutStamp(next)) stale.push(path.relative(REPO_ROOT, file));
  if (!CHECK) fs.writeFileSync(file, next, "utf-8");
}

const counts = `${mcp.tools.length} MCP tools, ${cli.groups.length} CLI groups, ${views.length} views, ${shortcuts.length} shortcuts`;
if (CHECK) {
  if (stale.length) {
    console.error("Bundled skill is stale — regenerate it:\n  node packages/server/scripts/generate-bundled-skill.mjs\n");
    for (const f of stale) console.error("  out of date: " + f);
    process.exit(1);
  }
  console.log(`Bundled skill is current (${counts}).`);
} else {
  console.log(`Wrote ${targets.length} file(s): ${counts}.`);
}
