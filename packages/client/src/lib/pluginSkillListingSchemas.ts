/**
 * Response schema for the per-skill listing-mode picker (#1252), spread into
 * `API_RESPONSE_SCHEMAS`.
 *
 * Self-contained on purpose: the registry imports this file, so this file may import NOTHING
 * from the registry (`no-circular`, `pnpm check:arch`) — and the registry module sits at the
 * god-module line ceiling, which is why the entry does not simply live there. The shape below
 * is structurally the registry's `Check` / `ObjectSchema`; a schema here passes through unknown
 * keys exactly as every registry schema does (see that file's "why no zod").
 */

interface FieldCheck {
  check(value: unknown, path: string, issues: string[]): void;
}

interface Schema {
  readonly fields: Record<string, FieldCheck>;
  validate(value: unknown, issues: string[]): void;
}

function typeOf(name: "string"): FieldCheck {
  return {
    check(value, path, issues) {
      if (typeof value !== name) issues.push(`${path}: expected ${name}, got ${value === null ? "null" : typeof value}`);
    },
  };
}
const str = typeOf("string");

function looseObject(fields: Record<string, FieldCheck>): Schema {
  return {
    fields,
    validate(value, issues) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        issues.push(`<root>: expected object, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const [key, check] of Object.entries(fields)) {
        if (!(key in record)) issues.push(`${key}: missing`);
        else check.check(record[key], key, issues);
      }
    },
  };
}

function nullable(inner: FieldCheck): FieldCheck {
  return { check: (value, path, issues) => { if (value !== null) inner.check(value, path, issues); } };
}

/**
 * `POST /api/plugins/:id/skills/:name/listing` (#1252) → `setSkillListingModeForProject`
 * (`plugin-enablement.service.ts`): `{ warning: string | null }`. `PluginsSettings` reads
 * `warning` (to toast it) and optimistically updates its own state rather than reading a
 * server-resolved listing back.
 */
const skillListingResult: Schema = looseObject({
  warning: nullable(str),
});

/** The registry entry, spread into `API_RESPONSE_SCHEMAS` (structurally `ApiResponseRoute`). */
export const PLUGIN_SKILL_LISTING_ROUTES: ReadonlyArray<{ method: "POST"; template: string; schema: Schema }> = [
  { method: "POST", template: "/api/plugins/:id/skills/:name/listing", schema: skillListingResult },
];
