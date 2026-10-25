// Read-only Jira context on pull (#1701): sprint and fix-version tags, the custom-field map and an
// attachment footer. Pure (no fetch, no fs). None of it is a snapshot field and none of it is pushed:
// the tags are filtered out of pushed labels (`labelsFromBoardTags`), the footer is stripped from any
// description before it leaves for Jira.

export const SPRINT_SCHEMA = "com.pyxis.greenhopper.jira:gh-sprint";
export const SPRINT_PREFIX = "sprint";
export const VERSION_PREFIX = "version";
export const ATTACHMENT_FOOTER_START = "<!-- jira-sync:attachments -->";
export const ATTACHMENT_FOOTER_END = "<!-- /jira-sync:attachments -->";

const FOOTER_RE = /\n*<!-- jira-sync:attachments -->[\s\S]*?<!-- \/jira-sync:attachments -->[ \t]*\n*/g;

/** The description without the plugin-owned attachment footer. */
export function stripAttachmentFooter(description) {
  if (description == null) return description;
  return String(description).replace(FOOTER_RE, "").replace(/\s+$/, "");
}

/** The footer block currently in a description ('' when none), for change detection. */
export function attachmentFooterOf(description) {
  const m = String(description ?? "").match(/<!-- jira-sync:attachments -->[\s\S]*?<!-- \/jira-sync:attachments -->/);
  return m ? m[0] : "";
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The footer for a Jira `attachment` array: name, size and Jira URL per file, no binary copy. '' when none. */
export function attachmentFooter(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a?.filename) : [];
  if (list.length === 0) return "";
  const lines = list.map((a) => {
    const size = humanSize(a.size);
    const url = a.content || a.self || "";
    return `- ${a.filename}${size ? ` (${size})` : ""}${url ? `: ${url}` : ""}`;
  });
  return [ATTACHMENT_FOOTER_START, "**Attachments (Jira, read-only):**", ...lines, ATTACHMENT_FOOTER_END].join("\n");
}

/** Body plus footer, as written to the board. */
export function withAttachmentFooter(body, footer) {
  if (!footer) return body;
  return body ? `${body}\n\n${footer}` : footer;
}

/** The id of the sprint custom field in a `GET /rest/api/3/field` listing, or null. Never hard-coded. */
export function findSprintFieldId(fieldCatalog = []) {
  return fieldCatalog.find((f) => f?.schema?.custom === SPRINT_SCHEMA)?.id ?? null;
}

/** `customFieldMap` setting (JSON object `{ "<field id or name>": "tag:<prefix>" }`) -> rows, or an error string. */
export function parseCustomFieldMap(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { rows: [] };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "customFieldMap: not valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object") return { error: "customFieldMap: must be a JSON object of Jira field -> tag:<prefix>" };
  const entries = Array.isArray(parsed) ? parsed.map((r) => [r?.jiraField, r?.tag]) : Object.entries(parsed);
  const rows = [];
  for (const [jiraField, target] of entries) {
    const m = /^(?:tag:)?\s*([^\s:]+)\s*$/i.exec(String(target ?? ""));
    if (!jiraField || !m) return { error: `customFieldMap: "${jiraField}" needs a target of the form tag:<prefix>` };
    rows.push({ jiraField: String(jiraField), prefix: m[1] });
  }
  return { rows };
}

/**
 * Resolves each row's Jira field (id or display name, case-insensitive) through the field catalog.
 * @returns {{ resolved: Array<{id:string,prefix:string,jiraField:string}>, unknown: string[] }}
 */
export function resolveCustomFieldMap(rows, fieldCatalog = []) {
  const resolved = [];
  const unknown = [];
  for (const row of rows) {
    const want = row.jiraField.trim().toLowerCase();
    const hit = fieldCatalog.find((f) => String(f.id).toLowerCase() === want) ?? fieldCatalog.find((f) => String(f.name ?? "").toLowerCase() === want);
    if (hit) resolved.push({ id: hit.id, prefix: row.prefix, jiraField: row.jiraField });
    else unknown.push(row.jiraField);
  }
  return { resolved, unknown };
}

/** The validation message for a map naming Jira fields that do not exist, or null. */
export function unknownFieldsMessage(unknown) {
  return unknown.length === 0 ? null : `customFieldMap: unknown Jira field${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}`;
}

/** Flattens one Jira field value into plain strings: option -> value, user -> displayName, array -> one per item. */
export function flattenFieldValue(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(flattenFieldValue);
  if (typeof value === "object") {
    const v = value.value ?? value.displayName ?? value.name ?? value.emailAddress ?? null;
    return v == null ? [] : [String(v).trim()].filter(Boolean);
  }
  return [String(value).trim()].filter(Boolean);
}

const tagValue = (v) => v.replace(/\s+/g, " ");

/**
 * The read-only tags and footer for one Jira issue.
 * @returns {{ tags: string[], footer: string }}
 */
export function jiraContextOf(jiraIssue, { sprintFieldId = null, customFields = [] } = {}) {
  const fields = jiraIssue.fields ?? {};
  const tags = [];
  if (sprintFieldId) {
    for (const s of Array.isArray(fields[sprintFieldId]) ? fields[sprintFieldId] : []) {
      const state = typeof s === "object" ? String(s?.state ?? "").toLowerCase() : "active";
      const name = typeof s === "object" ? s?.name : s;
      if (name && (state === "active" || state === "future")) tags.push(`${SPRINT_PREFIX}:${tagValue(String(name))}`);
    }
  }
  for (const v of Array.isArray(fields.fixVersions) ? fields.fixVersions : []) {
    if (v?.name) tags.push(`${VERSION_PREFIX}:${tagValue(String(v.name))}`);
  }
  for (const cf of customFields) {
    for (const v of flattenFieldValue(fields[cf.id])) tags.push(`${cf.prefix}:${tagValue(v)}`);
  }
  return { tags: [...new Set(tags)], footer: attachmentFooter(fields.attachment) };
}

/** Custom prefixes from the raw `customFieldMap` setting, for keeping them out of pushed labels. Never throws. */
export function customPrefixesFromSetting(raw) {
  return (parseCustomFieldMap(raw).rows ?? []).map((r) => r.prefix);
}

/** True when `tag` starts with one of `prefixes` followed by a colon. */
export function hasManagedPrefix(tag, prefixes) {
  const lower = String(tag).toLowerCase();
  return prefixes.some((p) => lower.startsWith(`${p.toLowerCase()}:`));
}
