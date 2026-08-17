/**
 * Backlog Markdown — a backlog as ONE human-readable, hand-editable, diff-able `.md` file, so a
 * backlog can be shared, reviewed, or moved between boards (and between the board and any
 * repo's BACKLOG.md) without a database in the loop.
 *
 * Two halves, both pure:
 *   renderBacklogMarkdown(doc)  — the STANDARD (`kanban-md: 1`): front matter, one `##` section per
 *                                 status, one `###` heading per issue with a metadata line, then the
 *                                 description and a checklist. Round-trips through parse losslessly
 *                                 for every field the board persists.
 *   parseBacklogMarkdown(text)  — LIBERAL: reads the standard AND the styles people already write —
 *                                 `## Section` + `- [ ] item` lists, `- **Title** — text`, `#12`
 *                                 anywhere in a title, `**Priority:** high`, `priority: high`, key:value
 *                                 tables, `depends on #3`, `blocked by #4`, `[x]` = done. Everything it
 *                                 was unsure about lands in `warnings`; `confidence` says how much of
 *                                 the file it understood, so a caller can hand a low-confidence file to
 *                                 an agent (the `backlog-markdown` skill) for normalisation instead.
 *
 * Deliberately NOT here: ids, workspaces, sessions, device paths — same exclusions as the JSON
 * backlog snapshot, of which this format is the readable twin. Spec: docs/backlog-markdown.md.
 */

export const BACKLOG_MD_VERSION = 1;

export interface BacklogMdChecklistItem { text: string; done: boolean }

export interface BacklogMdIssue {
  /** Project-local number from `#N` in the heading/list item; null when the source has none. */
  number: number | null;
  title: string;
  description: string;
  /** Section (status) name as written; null when the item sat above any `##` section. */
  status: string | null;
  priority: string | null;
  issueType: string | null;
  tags: string[];
  milestone: string | null;
  estimate: string | null;
  dueDate: string | null;
  externalKey: string | null;
  externalUrl: string | null;
  /** Numbers this issue depends on (`depends: #1, #2`, "blocked by #1", "after #1"). */
  dependsOn: number[];
  /** Numbers this issue blocks (`blocks: #3`) — the inverse edge, kept as written. */
  blocks: number[];
  checklist: BacklogMdChecklistItem[];
  /** `- [x]` on a list-item issue with no section: the author says it is done. */
  doneMark: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  /** 1-based line of the heading/list item in the source (for warnings and previews). */
  line: number;
}

export interface BacklogMdDoc {
  version: number | null;
  project: string | null;
  exportedAt: string | null;
  /** Section names in file order (the status columns the file was written against). */
  statuses: string[];
  filter: string | null;
  issues: BacklogMdIssue[];
  warnings: string[];
  /** 0..1 — share of "issue-looking" lines the parser could place; <0.6 = hand it to an agent. */
  confidence: number;
  /** "kanban-md" when the front matter declares the standard, else "liberal". */
  format: "kanban-md" | "liberal";
}

// ── normalisers (shared by parser and importer) ───────────────────────────────────────

export const PRIORITY_ALIASES: Record<string, string> = {
  critical: "critical", crit: "critical", urgent: "critical", blocker: "critical", p0: "critical", "p-0": "critical", highest: "critical",
  high: "high", p1: "high", "p-1": "high", important: "high",
  medium: "medium", med: "medium", normal: "medium", p2: "medium", "p-2": "medium", default: "medium",
  low: "low", minor: "low", p3: "low", "p-3": "low", p4: "low", lowest: "low", trivial: "low",
};
export function normalizePriority(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/^[!@]+/, "");
  return PRIORITY_ALIASES[k] ?? null;
}

export const TYPE_ALIASES: Record<string, string> = {
  task: "task", todo: "task", chore: "chore", maintenance: "chore", refactor: "chore", refactoring: "chore", tech: "chore", "tech-debt": "chore", debt: "chore",
  bug: "bug", defect: "bug", fix: "bug", bugfix: "bug", issue: "bug",
  feature: "feature", feat: "feature", story: "feature", enhancement: "feature", improvement: "feature",
  epic: "epic", initiative: "epic", theme: "epic",
};
export function normalizeIssueType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * Column-name synonyms → the canonical status names most boards carry. Used only when the
 * target project HAS the canonical status; an unknown section is otherwise created verbatim.
 */
export const STATUS_ALIASES: Record<string, string> = {
  backlog: "Backlog", todo: "Backlog", "to do": "Backlog", "to-do": "Backlog", open: "Backlog", new: "Backlog", ideas: "Backlog", planned: "Backlog", later: "Backlog", icebox: "Backlog", inbox: "Backlog", triage: "Backlog", ready: "Backlog", next: "Backlog", "up next": "Backlog",
  "in progress": "In Progress", "in-progress": "In Progress", doing: "In Progress", wip: "In Progress", started: "In Progress", active: "In Progress", "in work": "In Progress", now: "In Progress", current: "In Progress",
  "in review": "In Review", review: "In Review", "code review": "In Review", reviewing: "In Review", "ai reviewed": "AI Reviewed", "ready for merge": "Ready for Merge", verify: "In Review", qa: "In Review", testing: "In Review",
  done: "Done", closed: "Done", complete: "Done", completed: "Done", finished: "Done", shipped: "Done", merged: "Done", resolved: "Done", released: "Done",
  cancelled: "Cancelled", canceled: "Cancelled", wontfix: "Cancelled", "won't fix": "Cancelled", rejected: "Cancelled", dropped: "Cancelled", archived: "Archived",
  blocked: "Blocked", "on hold": "Blocked", waiting: "Blocked", paused: "Blocked",
};
export function canonicalStatusName(section: string): string {
  const k = section.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*\(\d+\)\s*$/, "");
  return STATUS_ALIASES[k] ?? section.trim().replace(/\s*\(\d+\)\s*$/, "");
}

// ── render (the standard) ─────────────────────────────────────────────────────────────

export interface RenderOptions {
  project?: string | null;
  exportedAt?: string | null;
  /** Section order; sections not listed are appended in first-seen order. */
  statuses?: string[];
  filter?: string | null;
  /** Emit created/updated timestamps in the metadata line (default true). */
  timestamps?: boolean;
  /** Emit "Depends on"/"Blocks" — default true. */
  dependencies?: boolean;
  /** Front-matter title override; default "<project> — backlog". */
  title?: string | null;
}

const esc = (s: string) => s.replace(/\r/g, "");

export function renderBacklogMarkdown(issues: BacklogMdIssue[], opts: RenderOptions = {}): string {
  const out: string[] = [];
  const project = opts.project ?? null;
  const sections: string[] = [...(opts.statuses ?? [])];
  for (const i of issues) { const s = i.status ?? "Backlog"; if (!sections.includes(s)) sections.push(s); }
  out.push("---");
  out.push(`kanban-md: ${BACKLOG_MD_VERSION}`);
  if (project) out.push(`project: ${yamlStr(project)}`);
  if (opts.exportedAt) out.push(`exported: ${opts.exportedAt}`);
  out.push(`statuses: ${sections.map(yamlStr).join(", ")}`);
  if (opts.filter) out.push(`filter: ${yamlStr(opts.filter)}`);
  out.push(`issues: ${issues.length}`);
  out.push("---");
  out.push("");
  out.push(`# ${opts.title ?? `${project ?? "Backlog"} — backlog`}`);
  out.push("");
  out.push("<!-- Backlog Markdown (kanban-md 1). One `##` per status column, one `###` per issue; the backtick line under a heading is its metadata. Edit freely and re-import — issues match by #number, then by title. Spec: docs/backlog-markdown.md -->");
  for (const section of sections) {
    const list = issues.filter((i) => (i.status ?? "Backlog") === section);
    out.push("", `## ${section}`, "");
    if (!list.length) { out.push("_(empty)_"); continue; }
    for (const i of list) {
      out.push(`### ${i.number != null ? `#${i.number} ` : ""}${esc(i.title).trim()}`);
      const meta: string[] = [];
      if (i.priority) meta.push(`priority: ${i.priority}`);
      if (i.issueType) meta.push(`type: ${i.issueType}`);
      if (i.tags.length) meta.push(`tags: ${i.tags.join(", ")}`);
      if (i.milestone) meta.push(`milestone: ${i.milestone}`);
      if (i.estimate) meta.push(`estimate: ${i.estimate}`);
      if (i.dueDate) meta.push(`due: ${i.dueDate}`);
      if (opts.dependencies !== false && i.dependsOn.length) meta.push(`depends: ${i.dependsOn.map((n) => `#${n}`).join(", ")}`);
      if (opts.dependencies !== false && i.blocks.length) meta.push(`blocks: ${i.blocks.map((n) => `#${n}`).join(", ")}`);
      if (i.externalKey) meta.push(`key: ${i.externalKey}`);
      if (i.externalUrl) meta.push(`url: ${i.externalUrl}`);
      if (opts.timestamps !== false && i.createdAt) meta.push(`created: ${i.createdAt.slice(0, 10)}`);
      if (opts.timestamps !== false && i.updatedAt) meta.push(`updated: ${i.updatedAt.slice(0, 10)}`);
      if (meta.length) out.push(meta.map((m) => `\`${m}\``).join(" · "));
      const desc = esc(i.description ?? "").trim();
      if (desc) out.push("", demoteHeadings(desc));
      if (i.checklist.length) { out.push(""); for (const c of i.checklist) out.push(`- [${c.done ? "x" : " "}] ${c.text}`); }
      out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function yamlStr(s: string): string {
  return /[:#,[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}
/** Headings inside a description would be read as new issues/sections — push them below ###. */
function demoteHeadings(desc: string): string {
  return desc.split("\n").map((l) => (/^#{1,3}\s/.test(l) ? "#### " + l.replace(/^#{1,3}\s+/, "") : l)).join("\n");
}

// ── parse (liberal) ───────────────────────────────────────────────────────────────────

const META_KEYS: Record<string, string> = {
  priority: "priority", prio: "priority", p: "priority",
  type: "issueType", kind: "issueType", issuetype: "issueType",
  tags: "tags", labels: "tags", label: "tags", tag: "tags",
  milestone: "milestone", sprint: "milestone", release: "milestone", iteration: "milestone",
  estimate: "estimate", est: "estimate", size: "estimate", points: "estimate", effort: "estimate",
  due: "dueDate", duedate: "dueDate", deadline: "dueDate",
  depends: "depends", "depends on": "depends", dependson: "depends", "blocked by": "depends", blockedby: "depends", after: "depends", needs: "depends", requires: "depends",
  blocks: "blocks", before: "blocks",
  key: "externalKey", external: "externalKey", externalkey: "externalKey", ref: "externalKey", id: "externalKey",
  url: "externalUrl", link: "externalUrl",
  created: "createdAt", updated: "updatedAt",
  status: "status", state: "status", column: "status",
};

const HASH_NUM = /#(\d+)\b/g;

function blankIssue(line: number): BacklogMdIssue {
  return { number: null, title: "", description: "", status: null, priority: null, issueType: null, tags: [], milestone: null,
    estimate: null, dueDate: null, externalKey: null, externalUrl: null, dependsOn: [], blocks: [], checklist: [], doneMark: false,
    createdAt: null, updatedAt: null, line };
}

/** Pull `#N` out of a title; returns the number and the title without it. */
export function splitNumberFromTitle(raw: string): { number: number | null; title: string } {
  let title = raw.trim();
  let number: number | null = null;
  const lead = title.match(/^(?:#|№|no\.?\s*)(\d+)\s*[:.\-—–]?\s*/i);
  if (lead) { number = Number(lead[1]); title = title.slice(lead[0].length); }
  else {
    const trail = title.match(/\s*[([]\s*#(\d+)\s*[)\]]\s*$/);
    if (trail) { number = Number(trail[1]); title = title.slice(0, trail.index).trim(); }
    else { const any = title.match(/(?:^|\s)#(\d+)(?=\s|$)/); if (any) { number = Number(any[1]); title = title.replace(any[0], " ").trim(); } }
  }
  return { number, title: title.replace(/^\*\*(.+?)\*\*[\s:—–-]*/, "$1 — ").replace(/\s—\s*$/, "").trim() };
}

/** Apply one `key: value` pair to an issue. Returns false when the key is not metadata. */
export function applyMeta(issue: BacklogMdIssue, keyRaw: string, valueRaw: string, warnings: string[]): boolean {
  const key = keyRaw.trim().toLowerCase().replace(/[*_`]/g, "");
  const field = META_KEYS[key];
  if (!field) return false;
  const value = valueRaw.trim().replace(/^[`*_]+|[`*_]+$/g, "").trim();
  const nums = () => [...value.matchAll(HASH_NUM)].map((m) => Number(m[1])).concat(value.match(/^\d+(\s*,\s*\d+)*$/) ? value.split(/\s*,\s*/).map(Number) : []);
  switch (field) {
    case "priority": { const p = normalizePriority(value); if (p) issue.priority = p; else warnings.push(`line ${issue.line}: unknown priority "${value}" (kept as medium)`); return true; }
    case "issueType": { const t = normalizeIssueType(value); if (t) issue.issueType = t; else warnings.push(`line ${issue.line}: unknown type "${value}"`); return true; }
    case "tags": issue.tags.push(...value.split(/[,;]\s*|\s+/).map((t) => t.replace(/^#/, "").trim()).filter(Boolean)); issue.tags = [...new Set(issue.tags)]; return true;
    case "milestone": issue.milestone = value || null; return true;
    case "estimate": issue.estimate = value || null; return true;
    case "dueDate": issue.dueDate = value || null; return true;
    case "depends": issue.dependsOn.push(...nums()); return true;
    case "blocks": issue.blocks.push(...nums()); return true;
    case "externalKey": issue.externalKey = value || null; return true;
    case "externalUrl": issue.externalUrl = value || null; return true;
    case "createdAt": issue.createdAt = value || null; return true;
    case "updatedAt": issue.updatedAt = value || null; return true;
    case "status": issue.status = value || null; return true;
    default: return false;
  }
}

/** A "metadata line": backtick tokens, `**Key:** value` runs, or `key: value` pairs separated by · | , ; */
export function parseMetaLine(issue: BacklogMdIssue, line: string, warnings: string[]): boolean {
  const l = line.trim();
  if (!l) return false;
  // 1. backtick tokens: `priority: high` · `tags: a, b`
  const ticks = [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  if (ticks.length && ticks.every((t) => /^[\w .-]+:\s*.+$/.test(t))) {
    let any = false;
    for (const t of ticks) { const i = t.indexOf(":"); any = applyMeta(issue, t.slice(0, i), t.slice(i + 1), warnings) || any; }
    if (any) return true;
  }
  // 2. **Key:** value · **Key2:** value2   or   Key: value | Key2: value2   (single line, ≥1 known key)
  const parts = l.split(/\s+[·|•]\s+|\s{2,}\|\s{2,}|;\s+/);
  const kv = /^[*_]*([A-Za-z][\w .-]{0,20}?)[*_]*\s*:\s*[*_]*(.+?)[*_]*$/;
  let matched = 0;
  const pending: Array<[string, string]> = [];
  for (const p of parts) { const m = p.trim().match(kv); if (m && META_KEYS[m[1].trim().toLowerCase().replace(/[*_`]/g, "")]) { pending.push([m[1], m[2]]); matched++; } }
  if (matched && matched === parts.length) { for (const [k, v] of pending) applyMeta(issue, k, v, warnings); return true; }
  // 3. a single "Key: value" line
  const m = l.match(kv);
  if (m && META_KEYS[m[1].trim().toLowerCase().replace(/[*_`]/g, "")]) return applyMeta(issue, m[1], m[2], warnings);
  // 4. relation phrases without a colon: "depends on #3, #4" · "blocked by #2" · "blocks #9" · "after #1"
  const rel = l.match(/^[*_]*(depends on|depends|blocked by|blocks|after|needs|requires)[*_]*\s+((?:#\d+[\s,and]*)+)$/i);
  if (rel) return applyMeta(issue, rel[1], rel[2], warnings);
  return false;
}

/** Inline hints inside a title: [high] (bug) !p1 @milestone — stripped from the title. */
function pullInlineHints(issue: BacklogMdIssue, warnings: string[]): void {
  let t = issue.title;
  const tryTok = (tok: string): boolean => {
    const k = tok.toLowerCase();
    if (normalizePriority(k)) { issue.priority = normalizePriority(k); return true; }
    if (normalizeIssueType(k)) { issue.issueType = normalizeIssueType(k); return true; }
    return false;
  };
  // !high  !p1  — bang priorities (first, so a trailing "[bug] !p1" leaves "[bug]" at the end)
  t = t.replace(/(^|\s)!([\w-]{1,10})(?=\s|$)/g, (m0, sp: string, tok: string) => (tryTok(tok) ? sp : m0)).trim();
  // trailing/leading bracketed tokens: [bug] [high] (P1)
  for (let guard = 0; guard < 4; guard++) {
    const m = t.match(/^\s*[[(]([\w -]{1,16})[\])]\s*/) || t.match(/\s*[[(]([\w -]{1,16})[\])]\s*$/);
    if (!m) break;
    const tok = m[1].trim();
    if (tryTok(tok)) t = (t.slice(0, m.index) + " " + t.slice(m.index! + m[0].length)).trim();
    else break;
  }
  void warnings;
  issue.title = t.replace(/\s{2,}/g, " ").trim();
}

export function parseBacklogMarkdown(text: string): BacklogMdDoc {
  const src = text.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const doc: BacklogMdDoc = { version: null, project: null, exportedAt: null, statuses: [], filter: null, issues: [], warnings: [], confidence: 0, format: "liberal" };
  let i = 0;
  // front matter
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = l.match(/^([\w-]+):\s*(.*)$/); if (!m) continue;
        const k = m[1].toLowerCase(), v = unyaml(m[2]);
        if (k === "kanban-md") { doc.version = Number(v) || 1; doc.format = "kanban-md"; }
        else if (k === "project" || k === "title") doc.project = doc.project ?? v;
        else if (k === "exported" || k === "exportedat" || k === "date") doc.exportedAt = v;
        else if (k === "statuses" || k === "columns") doc.statuses = v.split(",").map((s) => unyaml(s.trim())).filter(Boolean);
        else if (k === "filter") doc.filter = v;
      }
      i = end + 1;
    }
  }
  let section: string | null = null;
  let cur: BacklogMdIssue | null = null;
  let curKind: "heading" | "item" | null = null;
  let descLines: string[] = [];
  let candidateLines = 0, placedLines = 0;
  let inFence = false;
  const hasH2 = lines.some((l) => /^##\s/.test(l));
  const hasH3 = lines.some((l) => /^###\s/.test(l));
  const hasItems = lines.some((l) => /^([-*+]|\d+[.)])\s+/.test(l));
  // Which heading depth is "an issue": ### when present; ## only when there are no top-level list
  // items to be the issues (a `## Todo` + `- [ ] item` file has sections, not heading-issues).
  const issueLevel = hasH3 ? 3 : hasH2 && !hasItems ? 2 : 0;
  const sectionLevel = issueLevel === 3 ? 2 : issueLevel === 0 && hasH2 ? 2 : 0;
  const flush = () => {
    if (!cur) return;
    // description: metadata lines were consumed already; trailing blank lines dropped
    cur.description = descLines.join("\n").replace(/^\n+|\n+$/g, "");
    pullInlineHints(cur, doc.warnings);
    if (!cur.title) { doc.warnings.push(`line ${cur.line}: item without a title skipped`); }
    else doc.issues.push(cur);
    cur = null; curKind = null; descLines = [];
  };
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const ln = i + 1;
    if (/^\s*```/.test(raw)) { inFence = !inFence; if (cur) descLines.push(raw); continue; }
    if (inFence) { if (cur) descLines.push(raw); continue; }
    const h = raw.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length, textH = h[2].trim();
      if (level === 1 && !doc.project && !cur) { doc.project = textH.replace(/\s+[—–-]\s+backlog$/i, "").trim() || null; continue; }
      if (sectionLevel && level === sectionLevel) {     // a section
        flush();
        section = canonicalStatusName(textH);
        if (!doc.statuses.includes(section)) doc.statuses.push(section);
        continue;
      }
      if (level === issueLevel && issueLevel > 0) {    // an issue heading
        flush(); candidateLines++; placedLines++;
        cur = blankIssue(ln); curKind = "heading";
        const { number, title } = splitNumberFromTitle(textH);
        cur.number = number; cur.title = title; cur.status = section;
        continue;
      }
      // deeper heading inside an issue → part of the description
      if (cur) { descLines.push(raw); continue; }
      continue;
    }
    // table row `| #12 | Title | high | ... |` with a header row → treat rows as issues (liberal)
    const li = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/);
    if (li) {
      const indent = li[1].length, box = li[3], body = li[4];
      if (indent === 0 && (curKind !== "heading" || !cur)) {
        // top-level list item = an issue (unless we are inside a heading-issue where lists are content)
        flush(); candidateLines++; placedLines++;
        cur = blankIssue(ln); curKind = "item";
        const { number, title } = splitNumberFromTitle(body);
        cur.number = number; cur.title = title; cur.status = section; cur.doneMark = !!box && box !== " ";
        // "Title — description" on one line
        const dash = cur.title.match(/^(.{3,}?)\s+[—–]\s+(.+)$/);
        if (dash && !/^\*\*/.test(cur.title)) { cur.title = dash[1].trim(); descLines.push(dash[2].trim()); }
        continue;
      }
      if (cur) {
        if (box !== undefined) { cur.checklist.push({ text: body.trim(), done: box !== " " }); continue; }
        if (indent > 0 && curKind === "item" && parseMetaLine(cur, body, doc.warnings)) continue;
        if (indent > 0 && curKind === "item") { descLines.push(body); continue; }
        descLines.push(raw); continue;
      }
      candidateLines++;   // an orphan list line we could not place
      continue;
    }
    if (cur) {
      // metadata directly under the heading/item (before any prose): backtick line, **Key:** value, key: value
      if (descLines.every((d) => !d.trim()) && parseMetaLine(cur, raw, doc.warnings)) continue;
      // continuation lines under a list-item issue are indented to its body — dedent them
      descLines.push(curKind === "item" ? raw.replace(/^\s{1,4}/, "") : raw);
      continue;
    }
    // stray text before any issue: ignore, but count key: value pairs at top level as doc metadata
    const dm = raw.match(/^\**(project|title)\**\s*:\s*(.+)$/i);
    if (dm && !doc.project) doc.project = dm[2].trim();
  }
  flush();
  // done-marked items without a section → status "Done" if the file has such a section or is sectionless
  for (const is of doc.issues) if (is.doneMark && !is.status) is.status = "Done";
  doc.confidence = candidateLines ? placedLines / candidateLines : (doc.issues.length ? 1 : 0);
  if (!doc.issues.length) doc.warnings.push("no issues recognised — expected `### Title` headings under `## Status` sections, or `- [ ] Title` list items");
  return doc;
}

function unyaml(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"'))) { try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); } }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}
