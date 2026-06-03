import { issues, issueTags, tags, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createIssueService } from "../services/issue.service.js";
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
  number: number;
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
  const issueRows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      issueType: issues.issueType,
      estimate: issues.estimate,
      statusName: projectStatuses.name,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.issueNumber);

  if (issueRows.length === 0) return [];

  const issueIds = issueRows.map((r) => r.id);
  const tagRows = await database
    .select({ issueId: issueTags.issueId, tagName: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));

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

function parseJsonImport(body: unknown): { rows: ImportRow[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(body)) {
    errors.push("JSON body must be an array of issue objects");
    return { rows: [], errors };
  }
  const rows: ImportRow[] = [];
  for (let i = 0; i < body.length; i++) {
    const item = body[i];
    if (typeof item !== "object" || item === null) {
      errors.push(`Item ${i} is not an object`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    if (!obj.title || typeof obj.title !== "string" || !obj.title.trim()) {
      errors.push(`Item ${i}: title is required`);
      continue;
    }
    rows.push({
      title: String(obj.title).trim(),
      description: obj.description ? String(obj.description) : "",
      priority: obj.priority ? String(obj.priority) : "medium",
      issueType: obj.type ?? obj.issueType ? String(obj.type ?? obj.issueType) : "task",
      estimate: obj.estimate ? String(obj.estimate) : "",
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
      priority: priorityIdx !== -1 ? (fields[priorityIdx] ?? "medium").trim() || "medium" : "medium",
      issueType: typeIdx !== -1 ? (fields[typeIdx] ?? "task").trim() || "task" : "task",
      estimate: estimateIdx !== -1 ? (fields[estimateIdx] ?? "").trim() : "",
    });
  }
  return { rows, errors };
}

const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const VALID_ISSUE_TYPES = new Set(["task", "bug", "feature", "epic", "chore"]);

function validateAndMapRow(
  row: ImportRow,
  rowNum: number,
  seenTitles: Set<string>,
): { input: ImportInput | null; skipped: SkippedRow | null } {
  if (!row.title.trim()) {
    return { input: null, skipped: { row: rowNum, title: "", reason: "title is empty" } };
  }
  const titleKey = row.title.trim().toLowerCase();
  if (seenTitles.has(titleKey)) {
    return { input: null, skipped: { row: rowNum, title: row.title, reason: "duplicate title within this import" } };
  }
  seenTitles.add(titleKey);

  const priority = VALID_PRIORITIES.has(row.priority) ? row.priority : "medium";
  const issueType = VALID_ISSUE_TYPES.has(row.issueType) ? row.issueType : "task";

  return {
    input: {
      title: row.title.trim(),
      description: row.description || undefined,
      priority,
      issueType,
      estimate: row.estimate || null,
    },
    skipped: null,
  };
}

export function createIssueExportImportRoute(
  database: Database = db,
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

  // POST /api/projects/:projectId/issues/import
  // Accepts JSON body (array) or multipart form with a file field named "file"
  router.post("/:projectId/issues/import", async (c) => {
    const projectId = c.req.param("projectId");
    const contentType = c.req.header("content-type") ?? "";

    let parsedRows: ImportRow[] = [];
    let parseErrors: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return c.json({ error: "multipart upload must include a 'file' field" }, 400);
      }
      const text = await (file as File).text();
      const filename = (file as File).name?.toLowerCase() ?? "";
      if (filename.endsWith(".csv")) {
        ({ rows: parsedRows, errors: parseErrors } = parseCsvImport(text));
      } else {
        try {
          const json = JSON.parse(text);
          ({ rows: parsedRows, errors: parseErrors } = parseJsonImport(json));
        } catch {
          return c.json({ error: "Could not parse file as JSON or CSV" }, 400);
        }
      }
    } else if (contentType.includes("application/json")) {
      const body = await c.req.json();
      ({ rows: parsedRows, errors: parseErrors } = parseJsonImport(body));
    } else {
      return c.json({ error: "Content-Type must be application/json or multipart/form-data" }, 400);
    }

    if (parsedRows.length === 0 && parseErrors.length > 0) {
      return c.json({ error: "No valid rows found", parseErrors }, 400);
    }

    const seenTitles = new Set<string>();
    const validInputs: ImportInput[] = [];
    const skipped: SkippedRow[] = [];

    for (let i = 0; i < parsedRows.length; i++) {
      const { input, skipped: skip } = validateAndMapRow(parsedRows[i], i + 1, seenTitles);
      if (skip) {
        skipped.push(skip);
      } else if (input) {
        validInputs.push(input);
      }
    }

    let created = 0;
    if (validInputs.length > 0) {
      const results = await issueService.createIssuesBatch(projectId, validInputs);
      created = results.length;
    }

    return c.json({
      created,
      skipped: skipped.length,
      skippedRows: skipped,
      parseErrors,
    }, 201);
  });

  return router;
}
