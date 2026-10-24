// Sync direction (#1672): which way each mapped field flows, plus the toggles for the
// existing push kinds. Resolved from the board's `SYNC_CONFIG_*` env. Absent setting =
// `jira-to-board`, so an existing install never starts writing to Jira by surprise.

export const DIRECTIONS = ["both", "jira-to-board", "board-to-jira"];
export const DIRECTION_FIELDS = ["title", "description", "priority", "type", "labels"];
export const DEFAULT_DIRECTION = "jira-to-board";

const FIELD_ALIASES = { summary: "title", issuetype: "type", issuetypename: "type", tags: "labels" };
const flag = (raw, fallback = true) => (raw == null || String(raw).trim() === "" ? fallback : /^(1|true|yes|on)$/i.test(String(raw).trim()));

function normField(name) {
  const k = String(name).trim().toLowerCase();
  return FIELD_ALIASES[k] ?? k;
}

/** @returns {{ default: string, fields: Record<string,string>, pushStatus: boolean, pushComments: boolean }} */
export function resolveSyncDirections(env = process.env) {
  const raw = String(env.SYNC_CONFIG_SYNCDIRECTION ?? "").trim().toLowerCase();
  const base = DIRECTIONS.includes(raw) ? raw : DEFAULT_DIRECTION;
  let overrides = {};
  try {
    const parsed = JSON.parse(env.SYNC_CONFIG_FIELDDIRECTIONS || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) overrides = parsed;
  } catch {
    // a malformed override is ignored: the base direction applies
  }
  const fields = Object.fromEntries(DIRECTION_FIELDS.map((f) => [f, base]));
  for (const [name, dir] of Object.entries(overrides)) {
    const field = normField(name);
    if (DIRECTION_FIELDS.includes(field) && DIRECTIONS.includes(String(dir).toLowerCase())) fields[field] = String(dir).toLowerCase();
  }
  return {
    default: base,
    fields,
    pushStatus: flag(env.SYNC_CONFIG_PUSHSTATUS),
    pushComments: flag(env.SYNC_CONFIG_PUSHCOMMENTS),
  };
}

/** Every field direction as `jira-to-board`: what pull did before #1672. */
export const LEGACY_DIRECTIONS = Object.freeze({
  default: DEFAULT_DIRECTION,
  fields: Object.freeze(Object.fromEntries(DIRECTION_FIELDS.map((f) => [f, DEFAULT_DIRECTION]))),
  pushStatus: true,
  pushComments: true,
});

export const pushesField = (directions, field) => directions.fields[field] !== "jira-to-board";
export const pullsField = (directions, field) => directions.fields[field] !== "board-to-jira";
