import type { BacklogMdIssue } from "./backlog-markdown.js";

export const BACKLOG_MD_VERSION = 1;

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

/** The backtick metadata line under an issue heading; null when the issue carries none. */
function renderMetaLine(i: BacklogMdIssue, opts: RenderOptions): string | null {
  const meta: string[] = [];
  if (i.priority) meta.push(`priority: ${i.priority}`);
  if (i.issueType) meta.push(`type: ${i.issueType}`);
  if (i.tags.length) meta.push(`tags: ${i.tags.join(", ")}`);
  if (i.milestone) meta.push(`milestone: ${i.milestone}`);
  if (i.dueDate) meta.push(`due: ${i.dueDate}`);
  if (opts.dependencies !== false && i.dependsOn.length) meta.push(`depends: ${i.dependsOn.map((n) => `#${n}`).join(", ")}`);
  if (opts.dependencies !== false && i.blocks.length) meta.push(`blocks: ${i.blocks.map((n) => `#${n}`).join(", ")}`);
  if (i.externalKey) meta.push(`key: ${i.externalKey}`);
  if (i.externalUrl) meta.push(`url: ${i.externalUrl}`);
  if (opts.timestamps !== false && i.createdAt) meta.push(`created: ${i.createdAt.slice(0, 10)}`);
  if (opts.timestamps !== false && i.updatedAt) meta.push(`updated: ${i.updatedAt.slice(0, 10)}`);
  return meta.length ? meta.map((m) => `\`${m}\``).join(" · ") : null;
}

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
      const metaLine = renderMetaLine(i, opts);
      if (metaLine) out.push(metaLine);
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
