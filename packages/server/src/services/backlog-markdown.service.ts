import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { getProjectById, getProjectStatuses } from "../repositories/project.repository.js";
import { getFullIssuesForProject } from "../repositories/backlog-snapshot.repository.js";
import { getTagsForIssues, getDependenciesForIssues, assignTag } from "../repositories/issue.repository.js";
import { getTagByName } from "../repositories/issue-ai.repository.js";
import { createTag } from "../repositories/tag.repository.js";
import { exportBacklogSnapshot, importBacklogSnapshot, type BacklogSnapshot, type BacklogSnapshotIssue } from "./backlog-snapshot.service.js";
import { createIssueService } from "./issue.service.js";
import { createIssueDependencyService } from "./issue-dependency.service.js";
import { IssueError } from "./issue-error.js";
import {
  parseBacklogMarkdown, renderBacklogMarkdown, canonicalStatusName, STATUS_ALIASES,
  type BacklogMdDoc, type BacklogMdIssue,
} from "@agentic-kanban/shared/lib/backlog-markdown";

/**
 * Backlog Markdown — export a project's backlog as one readable `.md` (with filters), and import
 * such a file (standard OR liberal styles) back — creating new issues and, in `update` mode,
 * updating the ones that already exist. The JSON snapshot machinery is the persistence half
 * (statuses/tags/milestones/dependencies, renumbering); this module is the markdown face of it.
 *
 * Matching an imported issue to an existing one, in order: `#number` (when the file was exported
 * from THIS project or `matchBy` says so) → external key → title (case-insensitive, trimmed).
 * `mode: "create"` ignores matches and creates everything (renumbering on collision);
 * `mode: "update"` updates matched issues (fields present in the file win; tags are ADDED, never
 * removed; dependencies are added, never removed) and creates the rest.
 */

export interface ExportFilters {
  /** Status names (case-insensitive). Empty = all non-terminal unless includeDone. */
  statuses?: string[];
  includeDone?: boolean;
  tags?: string[];
  priorities?: string[];
  types?: string[];
  milestone?: string | null;
  /** Free-text over title+description. */
  q?: string | null;
  /** ISO date — only issues updated at/after. */
  since?: string | null;
  /** Issue numbers to include (explicit selection). */
  numbers?: number[];
  timestamps?: boolean;
  dependencies?: boolean;
  /** Body only — no front matter/H1 (for pasting into an existing document). */
  bare?: boolean;
}

const TERMINAL = new Set(["done", "cancelled", "canceled", "archived"]);

export function describeFilters(f: ExportFilters): string | null {
  const parts: string[] = [];
  if (f.statuses?.length) parts.push(`status=${f.statuses.join("|")}`);
  else if (!f.includeDone) parts.push("status=open");
  if (f.tags?.length) parts.push(`tag=${f.tags.join("|")}`);
  if (f.priorities?.length) parts.push(`priority=${f.priorities.join("|")}`);
  if (f.types?.length) parts.push(`type=${f.types.join("|")}`);
  if (f.milestone) parts.push(`milestone=${f.milestone}`);
  if (f.q) parts.push(`q=${f.q}`);
  if (f.since) parts.push(`since=${f.since}`);
  if (f.numbers?.length) parts.push(`numbers=${f.numbers.join(",")}`);
  return parts.length ? parts.join("; ") : null;
}

export function snapshotIssueToMd(i: BacklogSnapshotIssue, deps: BacklogSnapshot["dependencies"]): BacklogMdIssue {
  let checklist: { text: string; done: boolean }[] = [];
  if (i.checklistJson) {
    try {
      const arr = JSON.parse(i.checklistJson) as Array<{ text?: string; title?: string; completed?: boolean; done?: boolean }>;
      if (Array.isArray(arr)) checklist = arr.map((c) => ({ text: String(c.text ?? c.title ?? ""), done: !!(c.completed ?? c.done) })).filter((c) => c.text);
    } catch { /* not a list */ }
  }
  const n = i.issueNumber;
  return {
    number: n, title: i.title, description: i.description ?? "", status: i.status, priority: i.priority, issueType: i.issueType,
    tags: i.tags, milestone: i.milestone, estimate: i.estimate, dueDate: i.dueDate, externalKey: i.externalKey, externalUrl: i.externalUrl,
    dependsOn: n == null ? [] : deps.filter((d) => d.fromNumber === n && d.type !== "parent_of").map((d) => d.toNumber),
    blocks: n == null ? [] : deps.filter((d) => d.toNumber === n && d.type === "blocked_by").map((d) => d.fromNumber),
    checklist, doneMark: TERMINAL.has(i.status.toLowerCase()), createdAt: i.createdAt, updatedAt: i.updatedAt, line: 0,
  };
}

export function applyExportFilters(issues: BacklogSnapshotIssue[], f: ExportFilters): BacklogSnapshotIssue[] {
  const st = new Set((f.statuses ?? []).map((s) => s.toLowerCase()));
  const tg = new Set((f.tags ?? []).map((s) => s.toLowerCase()));
  const pr = new Set((f.priorities ?? []).map((s) => s.toLowerCase()));
  const ty = new Set((f.types ?? []).map((s) => s.toLowerCase()));
  const nums = new Set(f.numbers ?? []);
  const q = (f.q ?? "").trim().toLowerCase();
  return issues.filter((i) => {
    if (st.size ? !st.has(i.status.toLowerCase()) : (!f.includeDone && TERMINAL.has(i.status.toLowerCase()))) return false;
    if (tg.size && !i.tags.some((t) => tg.has(t.toLowerCase()))) return false;
    if (pr.size && !pr.has(i.priority.toLowerCase())) return false;
    if (ty.size && !ty.has(i.issueType.toLowerCase())) return false;
    if (f.milestone && (i.milestone ?? "").toLowerCase() !== f.milestone.toLowerCase()) return false;
    if (q && !(`${i.title}\n${i.description ?? ""}`.toLowerCase().includes(q))) return false;
    if (f.since && i.updatedAt < f.since) return false;
    if (nums.size && (i.issueNumber == null || !nums.has(i.issueNumber))) return false;
    return true;
  });
}

export async function exportBacklogMarkdown(projectId: string, filters: ExportFilters = {}, database: Database = db): Promise<{ markdown: string; count: number; project: string }> {
  const snapshot = await exportBacklogSnapshot(projectId, database);
  const selected = applyExportFilters(snapshot.issues, filters);
  const issues = selected.map((i) => snapshotIssueToMd(i, snapshot.dependencies));
  const statuses = snapshot.statuses.sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.name)
    .filter((s) => filters.statuses?.length ? filters.statuses.some((x) => x.toLowerCase() === s.toLowerCase()) : (filters.includeDone || !TERMINAL.has(s.toLowerCase())));
  let markdown = renderBacklogMarkdown(issues, {
    project: snapshot.project.name, exportedAt: snapshot.exportedAt, statuses, filter: describeFilters(filters),
    timestamps: filters.timestamps !== false, dependencies: filters.dependencies !== false,
  });
  if (filters.bare) markdown = markdown.replace(/^---[\s\S]*?---\n\n# [^\n]*\n\n<!--[\s\S]*?-->\n*/, "");
  return { markdown, count: issues.length, project: snapshot.project.name };
}

// ── import ────────────────────────────────────────────────────────────────────────────

export type ImportMode = "create" | "update";
export type MatchBy = "auto" | "number" | "key" | "title" | "none";

export interface ImportOptions {
  mode?: ImportMode;
  matchBy?: MatchBy;
  /** Status to give issues that sat above any section (default: the project's default status). */
  defaultStatus?: string | null;
  /** Section names the target does not have: "create" them (default) or "map" them to the default status. */
  unknownStatus?: "create" | "map";
}

export interface ImportPreviewRow {
  line: number;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  issueType: string;
  tags: string[];
  action: "create" | "update" | "unchanged";
  /** Existing issue number when matched. */
  matchedNumber: number | null;
  matchedBy: "number" | "key" | "title" | null;
  changes: string[];
}

export interface ImportPreview {
  format: BacklogMdDoc["format"];
  confidence: number;
  project: string | null;
  sameProject: boolean;
  mode: ImportMode;
  rows: ImportPreviewRow[];
  statusesToCreate: string[];
  tagsToCreate: string[];
  milestonesToCreate: string[];
  dependencies: number;
  warnings: string[];
  counts: { create: number; update: number; unchanged: number };
  /** <0.6 → suggest the agentic path (the `backlog-markdown` skill) instead of importing as-is. */
  lowConfidence: boolean;
}

interface Existing { id: string; issueNumber: number | null; title: string; description: string | null; status: string; priority: string; issueType: string; estimate: string | null; dueDate: string | null; externalKey: string | null; milestoneId: string | null; tags: string[]; dependsOn: number[]; checklist: { text: string; done: boolean }[] }

async function loadExisting(projectId: string, database: Database): Promise<{ existing: Existing[]; statusNames: string[]; defaultStatus: string; statusIdByName: Map<string, string> }> {
  const [statusRows, rows] = await Promise.all([getProjectStatuses(projectId, database), getFullIssuesForProject(projectId, database)]);
  const statusNameById = new Map(statusRows.map((s) => [s.id, s.name]));
  const ids = rows.map((r) => r.id);
  const [tagRows, depRows] = await Promise.all([getTagsForIssues(ids, database), getDependenciesForIssues(ids, database)]);
  const tagsByIssue = new Map<string, string[]>();
  for (const t of tagRows) { const l = tagsByIssue.get(t.issueId) ?? []; l.push(t.tagName); tagsByIssue.set(t.issueId, l); }
  const numberById = new Map(rows.map((r) => [r.id, r.issueNumber]));
  const depsByIssue = new Map<string, number[]>();
  for (const d of depRows) { const n = numberById.get(d.dependsOnId); if (n == null) continue; const l = depsByIssue.get(d.issueId) ?? []; l.push(n); depsByIssue.set(d.issueId, l); }
  const parseChecklist = (json: string | null): { text: string; done: boolean }[] => {
    if (!json) return [];
    try { const arr = JSON.parse(json) as Array<{ text?: string; title?: string; completed?: boolean; done?: boolean }>; return Array.isArray(arr) ? arr.map((c) => ({ text: String(c.text ?? c.title ?? ""), done: !!(c.completed ?? c.done) })) : []; } catch { return []; }
  };
  const existing: Existing[] = rows.map((r) => ({
    id: r.id, issueNumber: r.issueNumber, title: r.title, description: r.description, status: statusNameById.get(r.statusId) ?? "",
    priority: r.priority, issueType: r.issueType, estimate: r.estimate, dueDate: r.dueDate, externalKey: r.externalKey, milestoneId: r.milestoneId,
    tags: tagsByIssue.get(r.id) ?? [], dependsOn: depsByIssue.get(r.id) ?? [], checklist: parseChecklist(r.checklistJson),
  }));
  const def = statusRows.find((s) => s.isDefault) ?? statusRows.slice().sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return { existing, statusNames: statusRows.map((s) => s.name), defaultStatus: def?.name ?? "Backlog", statusIdByName: new Map(statusRows.map((s) => [s.name.toLowerCase(), s.id])) };
}

/** Resolve a section name against the target's statuses: exact → alias → (create | default). */
export function resolveStatusName(section: string | null, statusNames: string[], defaultStatus: string, unknown: "create" | "map"): { name: string; create: boolean } {
  if (!section) return { name: defaultStatus, create: false };
  const lower = new Map(statusNames.map((s) => [s.toLowerCase(), s]));
  const exact = lower.get(section.toLowerCase());
  if (exact) return { name: exact, create: false };
  const canon = canonicalStatusName(section);
  const viaAlias = lower.get(canon.toLowerCase());
  if (viaAlias) return { name: viaAlias, create: false };
  // the alias table maps to canonical names — if the target uses different casing/wording, try its own aliases the other way
  for (const [k, v] of Object.entries(STATUS_ALIASES)) if (v.toLowerCase() === canon.toLowerCase() && lower.get(k)) return { name: lower.get(k)!, create: false };
  return unknown === "map" ? { name: defaultStatus, create: false } : { name: section, create: true };
}

export async function previewBacklogMarkdownImport(projectId: string, text: string, opts: ImportOptions = {}, database: Database = db): Promise<ImportPreview & { doc: BacklogMdDoc }> {
  const project = await getProjectById(projectId, database);
  if (!project) throw new IssueError("Project not found", "NOT_FOUND");
  const doc = parseBacklogMarkdown(text);
  const mode: ImportMode = opts.mode ?? "update";
  const { existing, statusNames, defaultStatus } = await loadExisting(projectId, database);
  const sameProject = !!doc.project && doc.project.trim().toLowerCase() === project.name.trim().toLowerCase();
  const matchBy: MatchBy = opts.matchBy ?? "auto";
  const byNumber = new Map(existing.filter((e) => e.issueNumber != null).map((e) => [e.issueNumber!, e]));
  const byKey = new Map(existing.filter((e) => e.externalKey).map((e) => [e.externalKey!.toLowerCase(), e]));
  const byTitle = new Map(existing.map((e) => [e.title.trim().toLowerCase(), e]));
  const statusesToCreate = new Set<string>(); const tagsToCreate = new Set<string>(); const milestonesToCreate = new Set<string>();
  const existingTags = new Set(existing.flatMap((e) => e.tags.map((t) => t.toLowerCase())));
  const warnings = [...doc.warnings];
  const rows: ImportPreviewRow[] = doc.issues.map((mi) => {
    const st = resolveStatusName(mi.status ?? opts.defaultStatus ?? null, statusNames, defaultStatus, opts.unknownStatus ?? "create");
    if (st.create) statusesToCreate.add(st.name);
    for (const t of mi.tags) if (!existingTags.has(t.toLowerCase())) tagsToCreate.add(t);
    if (mi.milestone) milestonesToCreate.add(mi.milestone);
    let match: Existing | undefined; let matchedBy: ImportPreviewRow["matchedBy"] = null;
    if (mode === "update" && matchBy !== "none") {
      if ((matchBy === "auto" ? sameProject : matchBy === "number") && mi.number != null && byNumber.has(mi.number)) { match = byNumber.get(mi.number); matchedBy = "number"; }
      if (!match && (matchBy === "auto" || matchBy === "key") && mi.externalKey && byKey.has(mi.externalKey.toLowerCase())) { match = byKey.get(mi.externalKey.toLowerCase()); matchedBy = "key"; }
      if (!match && (matchBy === "auto" || matchBy === "title") && byTitle.has(mi.title.trim().toLowerCase())) { match = byTitle.get(mi.title.trim().toLowerCase()); matchedBy = "title"; }
      if (matchBy === "auto" && !sameProject && mi.number != null && byNumber.has(mi.number) && !match) {
        warnings.push(`line ${mi.line}: #${mi.number} exists here but the file is from another project ("${doc.project ?? "?"}") — matched by title/key only; pass matchBy=number to force`);
      }
    }
    const priority = mi.priority ?? match?.priority ?? "medium";
    const issueType = mi.issueType ?? match?.issueType ?? "task";
    const changes: string[] = [];
    if (match) {
      if (mi.title.trim() !== match.title.trim()) changes.push("title");
      if (mi.description.trim() && mi.description.trim() !== (match.description ?? "").trim()) changes.push("description");
      if (st.name.toLowerCase() !== match.status.toLowerCase()) changes.push(`status ${match.status} → ${st.name}`);
      if (mi.priority && mi.priority !== match.priority) changes.push(`priority ${match.priority} → ${mi.priority}`);
      if (mi.issueType && mi.issueType !== match.issueType) changes.push(`type ${match.issueType} → ${mi.issueType}`);
      if (mi.estimate && mi.estimate !== (match.estimate ?? "")) changes.push("estimate");
      if (mi.dueDate && mi.dueDate !== (match.dueDate ?? "")) changes.push("due");
      const newTags = mi.tags.filter((t) => !match.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
      if (newTags.length) changes.push(`+tags ${newTags.join(",")}`);
      const newDeps = mi.dependsOn.filter((n) => !match.dependsOn.includes(n));
      if (newDeps.length) changes.push(`+depends ${newDeps.map((n) => "#" + n).join(",")}`);
      const sameChecklist = mi.checklist.length === match.checklist.length && mi.checklist.every((c, j) => c.text === match.checklist[j]?.text && c.done === match.checklist[j]?.done);
      if (mi.checklist.length && !sameChecklist) changes.push("checklist");
      // a description that only differs by the export's heading demotion / whitespace is not a change
      const norm = (d: string) => d.replace(/^#### /gm, "## ").replace(/\s+/g, " ").trim();
      if (changes.includes("description") && norm(mi.description) === norm(match.description ?? "")) changes.splice(changes.indexOf("description"), 1);
    }
    return {
      line: mi.line, number: mi.number, title: mi.title, status: st.name, priority, issueType, tags: mi.tags,
      action: match ? (changes.length ? "update" : "unchanged") : "create",
      matchedNumber: match?.issueNumber ?? null, matchedBy, changes,
    };
  });
  const inFile = new Set(doc.issues.map((i) => i.number).filter((n): n is number => n != null));
  for (const mi of doc.issues) for (const n of [...mi.dependsOn, ...mi.blocks]) {
    if (!inFile.has(n)) warnings.push(`line ${mi.line}: refers to #${n}, which is not in this file — ${byNumber.has(n) ? `will link to the existing #${n}` : "no such issue here; the edge will be skipped"}`);
  }
  const counts = { create: rows.filter((r) => r.action === "create").length, update: rows.filter((r) => r.action === "update").length, unchanged: rows.filter((r) => r.action === "unchanged").length };
  return {
    doc, format: doc.format, confidence: doc.confidence, project: doc.project, sameProject, mode, rows,
    statusesToCreate: [...statusesToCreate], tagsToCreate: [...tagsToCreate], milestonesToCreate: [...milestonesToCreate],
    dependencies: doc.issues.reduce((n, i) => n + i.dependsOn.length + i.blocks.length, 0), warnings, counts,
    lowConfidence: doc.confidence < 0.6 || doc.issues.length === 0,
  };
}

export interface ImportResult {
  created: number; updated: number; unchanged: number;
  createdNumbers: number[]; updatedNumbers: number[];
  createdStatuses: string[]; createdTags: string[]; createdMilestones: string[];
  createdDependencies: number; warnings: string[];
}

export async function applyBacklogMarkdownImport(projectId: string, text: string, opts: ImportOptions = {}, database: Database = db, boardEvents?: BoardEvents): Promise<ImportResult> {
  const preview = await previewBacklogMarkdownImport(projectId, text, opts, database);
  const { doc, rows } = preview;
  const warnings = [...preview.warnings];
  const nowIso = new Date().toISOString();
  // 1. creates → one snapshot import (statuses/tags/milestones/deps/renumbering come for free)
  const createIdx = rows.map((r, i) => (r.action === "create" ? i : -1)).filter((i) => i >= 0);
  const createdSourceNumbers = new Set(createIdx.map((i) => doc.issues[i].number).filter((n): n is number => n != null));
  const snapshotIssues: BacklogSnapshotIssue[] = createIdx.map((i, k) => {
    const mi = doc.issues[i], r = rows[i];
    return {
      issueNumber: mi.number, title: mi.title, description: mi.description || null, priority: r.priority, issueType: r.issueType, sortOrder: k,
      status: r.status, milestone: mi.milestone, estimate: mi.estimate, dueDate: mi.dueDate, externalKey: mi.externalKey, externalUrl: mi.externalUrl,
      pinned: false, skipAutoReview: false,
      checklistJson: mi.checklist.length ? JSON.stringify(mi.checklist.map((c, j) => ({ id: `md-${j + 1}`, text: c.text, completed: c.done }))) : null,
      touchedFilesJson: null, tags: mi.tags, createdAt: mi.createdAt && /^\d{4}-\d{2}-\d{2}/.test(mi.createdAt) ? new Date(mi.createdAt).toISOString() : nowIso,
      updatedAt: nowIso, statusChangedAt: null,
    };
  });
  // dependencies among CREATED issues that carry numbers ride the snapshot; every other edge
  // (touching an existing issue, or from an unnumbered new issue) is added after the create pass,
  // once the new issues have numbers.
  const deps: BacklogSnapshot["dependencies"] = [];
  const laterEdges: Array<{ fromNumber: number; toNumber: number }> = [];
  const pendingByTitle: Array<{ title: string; dependsOn: number[]; blocks: number[] }> = [];
  for (const i of createIdx) {
    const mi = doc.issues[i];
    if (mi.number == null) { if (mi.dependsOn.length || mi.blocks.length) pendingByTitle.push({ title: mi.title, dependsOn: mi.dependsOn, blocks: mi.blocks }); continue; }
    for (const to of mi.dependsOn) (createdSourceNumbers.has(to) ? deps : laterEdges).push({ fromNumber: mi.number, toNumber: to, type: "depends_on" } as never);
    for (const b of mi.blocks) (createdSourceNumbers.has(b) ? deps : laterEdges).push({ fromNumber: b, toNumber: mi.number, type: "depends_on" } as never);
  }
  const result: ImportResult = { created: 0, updated: 0, unchanged: preview.counts.unchanged, createdNumbers: [], updatedNumbers: [], createdStatuses: [], createdTags: [], createdMilestones: [], createdDependencies: 0, warnings };
  if (snapshotIssues.length) {
    const snap: BacklogSnapshot = {
      kind: "agentic-kanban-backlog-snapshot", formatVersion: 1, exportedAt: nowIso, project: { name: doc.project ?? "markdown" },
      statuses: preview.statusesToCreate.map((name, i) => ({ name, sortOrder: 1000 + i, isDefault: false })),
      milestones: preview.milestonesToCreate.map((name) => ({ name, dueDate: null })), tags: preview.tagsToCreate.map((name) => ({ name, color: null })),
      issues: snapshotIssues, dependencies: deps,
    };
    const r = await importBacklogSnapshot(projectId, snap, database);
    result.created = r.createdIssues; result.createdStatuses = r.createdStatuses; result.createdTags = r.createdTags; result.createdMilestones = r.createdMilestones;
    result.createdDependencies += r.createdDependencies; result.warnings.push(...r.warnings);
  }
  // unnumbered new issues now have numbers — resolve their edges by title
  if (pendingByTitle.length) {
    const { existing: created } = await loadExisting(projectId, database);
    for (const pnd of pendingByTitle) {
      const hit = created.find((e) => e.title.trim().toLowerCase() === pnd.title.trim().toLowerCase() && e.issueNumber != null);
      if (!hit) { result.warnings.push(`"${pnd.title}": could not resolve its number after creation — dependencies skipped`); continue; }
      for (const to of pnd.dependsOn) laterEdges.push({ fromNumber: hit.issueNumber!, toNumber: to });
      for (const b of pnd.blocks) laterEdges.push({ fromNumber: b, toNumber: hit.issueNumber! });
    }
  }
  // 2. updates — field-wise through the issue service (events, webhooks, transitions all fire)
  const updateIdx = rows.map((r, i) => (r.action === "update" ? i : -1)).filter((i) => i >= 0);
  if (updateIdx.length || laterEdges.length) {
    const issueService = createIssueService({ database, boardEvents });
    const depService = createIssueDependencyService({ database, boardEvents });
    const { existing, statusIdByName } = await loadExisting(projectId, database);
    const byNumber = new Map(existing.filter((e) => e.issueNumber != null).map((e) => [e.issueNumber!, e]));
    for (const i of updateIdx) {
      const mi = doc.issues[i], r = rows[i];
      const ex = r.matchedNumber != null ? byNumber.get(r.matchedNumber) : undefined;
      if (!ex) continue;
      const body: Record<string, unknown> = {};
      if (r.changes.includes("title")) body.title = mi.title;
      if (r.changes.includes("description")) body.description = mi.description;
      if (mi.priority && mi.priority !== ex.priority) body.priority = mi.priority;
      if (mi.issueType && mi.issueType !== ex.issueType) body.issueType = mi.issueType;
      if (mi.estimate && mi.estimate !== ex.estimate) body.estimate = mi.estimate;
      if (mi.dueDate && mi.dueDate !== ex.dueDate) body.dueDate = mi.dueDate;
      const sid = statusIdByName.get(r.status.toLowerCase());
      if (sid && r.status.toLowerCase() !== ex.status.toLowerCase()) body.statusId = sid;
      if (r.changes.includes("checklist")) body.checklist = mi.checklist.map((c, j) => ({ id: `md-${j + 1}`, text: c.text, completed: c.done }));
      try {
        if (Object.keys(body).length) await issueService.updateIssue(ex.id, body);
        for (const t of mi.tags) {
          if (ex.tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
          const found = await getTagByName(t, database);
          const tagId = found[0]?.id ?? (await createTag(t, null, database)).id;
          await assignTag(ex.id, tagId, database);
          if (!found[0]) result.createdTags.push(t);
        }
        for (const to of mi.dependsOn) if (!ex.dependsOn.includes(to)) laterEdges.push({ fromNumber: ex.issueNumber!, toNumber: to });
        for (const b of mi.blocks) laterEdges.push({ fromNumber: b, toNumber: ex.issueNumber! });
        result.updated++; result.updatedNumbers.push(ex.issueNumber!);
      } catch (e) {
        result.warnings.push(`#${ex.issueNumber}: update failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 3. cross edges (existing ↔ created, existing ↔ existing) — reload numbers after the create pass
    const { existing: after } = await loadExisting(projectId, database);
    const idByNumber = new Map(after.filter((e) => e.issueNumber != null).map((e) => [e.issueNumber!, e.id]));
    const seen = new Set<string>();
    for (const e of laterEdges) {
      const k = `${e.fromNumber}>${e.toNumber}`; if (seen.has(k)) continue; seen.add(k);
      const from = idByNumber.get(e.fromNumber), to = idByNumber.get(e.toNumber);
      if (!from || !to) { result.warnings.push(`dependency #${e.fromNumber} → #${e.toNumber} skipped (unknown number)`); continue; }
      try { await depService.addDependency(from, to, "depends_on"); result.createdDependencies++; }
      catch (err) { const m = err instanceof Error ? err.message : String(err); if (!/already|exists|duplicate/i.test(m)) result.warnings.push(`dependency #${e.fromNumber} → #${e.toNumber}: ${m}`); }
    }
  }
  const { existing: finalRows } = await loadExisting(projectId, database);
  const known = new Set(finalRows.map((e) => e.issueNumber));
  result.createdNumbers = createIdx.map((i) => doc.issues[i].number).filter((n): n is number => n != null && known.has(n));
  boardEvents?.broadcast(projectId, "internal_notify");
  return result;
}
