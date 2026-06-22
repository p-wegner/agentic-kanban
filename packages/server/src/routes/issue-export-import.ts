import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createIssueService } from "../services/issue.service.js";
import { getIssuesForExport, getTagsForIssues } from "../repositories/issue.repository.js";
import { createRouter } from "../middleware/create-router.js";

const EXPORT_COLUMNS = [
  "number",
  "title",
  "description",
  "status",
  "priority",
  "type",
  "tags",
  "estimate",
  "createdAt",
  "updatedAt",
] as const;

interface ExportRow {
  number: number | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  type: string;
  tags: string;
  estimate: string;
  createdAt: string;
  updatedAt: string;
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowsToCsv(rows: ExportRow[]): string {
  const header = EXPORT_COLUMNS.join(",");
  const lines = rows.map((row) =>
    [
      escapeCsvField(String(row.number)),
      escapeCsvField(row.title),
      escapeCsvField(row.description),
      escapeCsvField(row.status),
      escapeCsvField(row.priority),
      escapeCsvField(row.type),
      escapeCsvField(row.tags),
      escapeCsvField(row.estimate),
      escapeCsvField(row.createdAt),
      escapeCsvField(row.updatedAt),
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

async function fetchExportRows(projectId: string, database: Database): Promise<ExportRow[]> {
  const issueRows = await getIssuesForExport(projectId, database);

  if (issueRows.length === 0) return [];

  const issueIds = issueRows.map((r) => r.id);
  const tagRows = await getTagsForIssues(issueIds, database);

  const tagsByIssue = new Map<string, string[]>();
  for (const tr of tagRows) {
    const list = tagsByIssue.get(tr.issueId) ?? [];
    list.push(tr.tagName);
    tagsByIssue.set(tr.issueId, list);
  }

  return issueRows.map((row) => ({
    number: row.issueNumber,
    title: row.title,
    description: row.description ?? "",
    status: row.statusName,
    priority: row.priority,
    type: row.issueType,
    tags: (tagsByIssue.get(row.id) ?? []).join(";"),
    estimate: row.estimate ?? "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

type ImportFormat = "csv" | "markdown" | "json";

interface ImportInput {
  title: string;
  description?: string;
  priority?: string;
  issueType?: string;
  estimate?: string | null;
}

interface ImportRow {
  title: string;
  description: string;
  priority: string;
  issueType: string;
  estimate: string;
}

interface SkippedRow {
  row: number;
  title: string;
  reason: string;
}

interface WarningRow {
  row: number;
  title: string;
  field: "priority" | "type";
  message: string;
}

/** A row that survived validation, with its final resolved values. */
interface PreviewRow {
  row: number;
  title: string;
  description: string;
  priority: string;
  issueType: string;
  estimate: string;
}

const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_ISSUE_TYPES = new Set(["task", "bug", "feature", "epic", "chore"]);
// Bulk import defaults for a missing/invalid priority or type (#426): medium /
// feature. (Manual single-issue create still defaults to medium / task.)
const DEFAULT_PRIORITY = "medium";
const DEFAULT_ISSUE_TYPE = "feature";

// Parsers emit the RAW value for priority/type (empty string when absent). The
// shared `validateRows` step applies defaults + records a warning only when a
// value was present-but-invalid, so omitted fields default silently.

/**
 * Coerce a raw (untyped JSON) import field to a string with the SAME runtime
 * output `String(value)` produced. Strings pass through; primitives use their
 * normal string form; a non-primitive routes through its own `toString` and so
 * reproduces the exact result (e.g. `[object Object]`) it would have yielded
 * before. Typing the object branch as `{ toString(): string }` keeps
 * `no-base-to-string` satisfied while leaving every visible output unchanged.
 * In practice these import fields are always scalars; the object branch only
 * preserves the prior latent behavior for the never-hit non-scalar case.
 */
function importFieldToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    return (value as { toString(): string }).toString();
  }
  // number | bigint | boolean | undefined | null | symbol | function.
  return `${value as number | bigint | boolean | null | undefined}`;
}

function parseJsonImport(body: unknown): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(body)) {
    errors.push("JSON body must be an array of issue objects");
    return { rows: [], errors };
  }
  const rows: ImportRow[] = [];
  const items: unknown[] = body;
  for (let i = 0; i < items.length; i++) {
    const item: unknown = items[i];
    if (typeof item !== "object" || item === null) {
      errors.push(`Item ${i} is not an object`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (!obj.title || typeof obj.title !== "string" || !obj.title.trim()) {
      errors.push(`Item ${i}: title is required`);
      continue;
    }
    const rawType = obj.type ?? obj.issueType;
    rows.push({
      title: String(obj.title).trim(),
      description: obj.description ? importFieldToString(obj.description) : "",
      priority: obj.priority ? importFieldToString(obj.priority).trim() : "",
      issueType: rawType ? importFieldToString(rawType).trim() : "",
      estimate: obj.estimate ? importFieldToString(obj.estimate).trim() : "",
    });
  }
  return { rows, errors };
}

function parseCsvImport(text: string): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    errors.push("CSV is empty");
    return { rows: [], errors };
  }
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  if (titleIdx === -1) {
    errors.push("CSV must have a 'title' column");
    return { rows: [], errors };
  }
  const descIdx = header.indexOf("description");
  const priorityIdx = header.indexOf("priority");
  const typeIdx = header.indexOf("type");
  const estimateIdx = header.indexOf("estimate");

  const rows: ImportRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const title = (fields[titleIdx] ?? "").trim();
    if (!title) {
      errors.push(`Row ${i + 1}: title is empty, skipping`);
      continue;
    }
    rows.push({
      title,
      description: descIdx !== -1 ? (fields[descIdx] ?? "").trim() : "",
      priority: priorityIdx !== -1 ? (fields[priorityIdx] ?? "").trim() : "",
      issueType: typeIdx !== -1 ? (fields[typeIdx] ?? "").trim() : "",
      estimate: estimateIdx !== -1 ? (fields[estimateIdx] ?? "").trim() : "",
    });
  }
  return { rows, errors };
}

/**
 * Markdown import (#426): one issue per top-level bullet (`-`, `*`, or `+` at
 * column 0). Indented sub-bullets following a top-level item become its
 * description (joined with newlines). Headings, blank lines, and other prose
 * are ignored. Markdown issues have no priority/type columns, so those default
 * to medium / feature via validateRows.
 */
function parseMarkdownImport(text: string): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ImportRow[] = [];
  const lines = text.split(/\r?\n/);
  const bulletRe = /^([ \t]*)([-*+])\s+(.+?)\s*$/;
  let currentTitle: string | null = null;
  let descLines: string[] = [];

  const flush = () => {
    if (currentTitle !== null) {
      rows.push({
        title: currentTitle,
        description: descLines.join("\n"),
        priority: "",
        issueType: "",
        estimate: "",
      });
    }
    currentTitle = null;
    descLines = [];
  };

  for (const line of lines) {
    const m = line.match(bulletRe);
    if (!m) continue;
    const indent = m[1].length;
    const body = m[3];
    if (indent === 0) {
      flush();
      currentTitle = body;
    } else if (currentTitle !== null) {
      // Sub-bullet → description line of the current issue.
      descLines.push(body);
    }
    // An orphan sub-bullet (indented, no parent) is ignored.
  }
  flush();

  if (rows.length === 0) {
    errors.push("No top-level list items (- or *) found");
  }
  return { rows, errors };
}

function formatHintFromFilename(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.endsWith(".csv")) return "csv";
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "markdown";
  if (n.endsWith(".json")) return "json";
  return "auto";
}

function detectFormat(text: string, hint?: string): ImportFormat {
  const h = (hint ?? "auto").toLowerCase();
  if (h === "csv") return "csv";
  if (h === "markdown" || h === "md") return "markdown";
  if (h === "json") return "json";
  // auto: JSON array/object wins, then markdown (has a top-level bullet), else csv.
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not parseable JSON — fall through
    }
  }
  if (/^[ \t]*[-*+]\s+\S/m.test(text)) return "markdown";
  return "csv";
}

function parseText(text: string, format: ImportFormat): { rows: ImportRow[]; errors: string[] } {
  if (format === "json") {
    try {
      return parseJsonImport(JSON.parse(text));
    } catch {
      return { rows: [], errors: ["Invalid JSON: could not parse"] };
    }
  }
  if (format === "markdown") return parseMarkdownImport(text);
  return parseCsvImport(text);
}

/**
 * Validate + default parsed rows. Shared by the preview and commit endpoints so
 * the preview is exactly what gets created. Dedupes titles within the import,
 * skips empty/duplicate titles, defaults missing/invalid priority & type, and
 * records a per-row warning only when a present value was invalid.
 */
function validateRows(parsedRows: ImportRow[]): {
  validInputs: ImportInput[];
  skipped: SkippedRow[];
  warnings: WarningRow[];
  previewRows: PreviewRow[];
} {
  const seenTitles = new Set<string>();
  const validInputs: ImportInput[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: WarningRow[] = [];
  const previewRows: PreviewRow[] = [];

  for (let i = 0; i < parsedRows.length; i++) {
    const rowNum = i + 1;
    const row = parsedRows[i];
    const title = row.title.trim();
    if (!title) {
      skipped.push({ row: rowNum, title: row.title, reason: "title is empty" });
      continue;
    }
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) {
      skipped.push({ row: rowNum, title, reason: "duplicate title within this import" });
      continue;
    }
    seenTitles.add(titleKey);

    const priorityRaw = row.priority.trim();
    let priority = priorityRaw;
    if (!priorityRaw) {
      priority = DEFAULT_PRIORITY;
    } else if (!VALID_PRIORITIES.has(priorityRaw)) {
      warnings.push({
        row: rowNum,
        title,
        field: "priority",
        message: `invalid priority "${priorityRaw}", defaulting to ${DEFAULT_PRIORITY}`,
      });
      priority = DEFAULT_PRIORITY;
    }

    const typeRaw = row.issueType.trim();
    let issueType = typeRaw;
    if (!typeRaw) {
      issueType = DEFAULT_ISSUE_TYPE;
    } else if (!VALID_ISSUE_TYPES.has(typeRaw)) {
      warnings.push({
        row: rowNum,
        title,
        field: "type",
        message: `invalid type "${typeRaw}", defaulting to ${DEFAULT_ISSUE_TYPE}`,
      });
      issueType = DEFAULT_ISSUE_TYPE;
    }

    const description = row.description.trim() || undefined;
    const estimate = row.estimate.trim() || null;
    validInputs.push({ title, description, priority, issueType, estimate });
    previewRows.push({
      row: rowNum,
      title,
      description: row.description.trim(),
      priority,
      issueType,
      estimate: row.estimate.trim(),
    });
  }

  return { validInputs, skipped, warnings, previewRows };
}

export function createIssueExportImportRoute(
  database: Database,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const issueService = createIssueService({ database, boardEvents: options?.boardEvents });

  // GET /api/projects/:projectId/issues/export?format=csv|json
  router.get("/:projectId/issues/export", async (c) => {
    const projectId = c.req.param("projectId");
    const format = (c.req.query("format") ?? "json").toLowerCase();
    if (format !== "csv" && format !== "json") {
      return c.json({ error: "format must be csv or json" }, 400);
    }

    const rows = await fetchExportRows(projectId, database);

    if (format === "csv") {
      const csv = rowsToCsv(rows);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="issues-${projectId}.csv"`,
        },
      });
    }

    return new Response(JSON.stringify(rows, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="issues-${projectId}.json"`,
      },
    });
  });

  // POST /api/projects/:projectId/issues/import/preview
  // Parse text WITHOUT persisting. Accepts JSON { text, format } or a multipart
  // "file" upload. Returns the detected format, resolved preview rows, and any
  // per-row warnings/skips so the client can show a preview table before commit.
  router.post("/:projectId/issues/import/preview", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let text = "";
    let hint = "auto";

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (file && typeof file !== "string") {
        text = await (file).text();
        hint = formatHintFromFilename((file).name);
      } else {
        const t = formData.get("text");
        if (typeof t === "string") text = t;
        const f = formData.get("format");
        if (typeof f === "string") hint = f;
      }
    } else if (contentType.includes("application/json")) {
      const body: unknown = await c.req.json().catch(() => null);
      const obj =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      if (obj && typeof obj.text === "string") {
        text = String(obj.text);
        hint = obj.format ? importFieldToString(obj.format) : "auto";
      } else if (typeof body === "string") {
        text = body;
      } else if (Array.isArray(body)) {
        text = JSON.stringify(body);
        hint = "json";
      } else {
        return c.json({ error: "Body must be { text, format } or a JSON array" }, 400);
      }
    } else {
      return c.json({ error: "Content-Type must be application/json or multipart/form-data" }, 400);
    }

    const format = detectFormat(text, hint);
    const { rows: parsedRows, errors: parseErrors } = parseText(text, format);
    const { skipped, warnings, previewRows } = validateRows(parsedRows);

    return c.json({ format, rows: previewRows, skipped, warnings, parseErrors });
  });

  // POST /api/projects/:projectId/issues/import
  // Accepts: a JSON array of issues, a JSON { text, format } object
  // (format = auto|csv|markdown|json), or a multipart form with a "file" field.
  // Parses (CSV / Markdown / JSON), skips malformed rows, and bulk-creates the
  // rest into the project's default (Backlog) status.
  router.post("/:projectId/issues/import", async (c) => {
    const projectId = c.req.param("projectId");
    const contentType = c.req.header("content-type") ?? "";

    let text: string | undefined;
    let hint = "auto";

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return c.json({ error: "multipart upload must include a 'file' field" }, 400);
      }
      text = await (file).text();
      hint = formatHintFromFilename((file).name);
    } else if (contentType.includes("application/json")) {
      const body: unknown = await c.req.json().catch(() => null);
      const obj =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      if (Array.isArray(body)) {
        text = JSON.stringify(body);
        hint = "json";
      } else if (obj && typeof obj.text === "string") {
        text = String(obj.text);
        hint = obj.format ? importFieldToString(obj.format) : "auto";
      } else {
        return c.json({ error: "JSON body must be an array of issues or a { text, format } object" }, 400);
      }
    } else {
      return c.json({ error: "Content-Type must be application/json or multipart/form-data" }, 400);
    }

    const format = detectFormat(text, hint);
    const { rows: parsedRows, errors: parseErrors } = parseText(text, format);

    if (parsedRows.length === 0 && parseErrors.length > 0) {
      return c.json({ error: "No valid rows found", parseErrors }, 400);
    }

    const { validInputs, skipped, warnings } = validateRows(parsedRows);

    let created = 0;
    if (validInputs.length > 0) {
      const results = await issueService.createIssuesBatch(projectId, validInputs);
      created = results.issues.length;
    }

    return c.json({
      created,
      skipped: skipped.length,
      skippedRows: skipped,
      parseErrors,
      warnings,
    }, 201);
  });

  return router;
}
