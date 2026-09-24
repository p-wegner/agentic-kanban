/**
 * Response schemas for the async merge path (#1250), spread into `API_RESPONSE_SCHEMAS`.
 *
 * Self-contained on purpose: the registry imports this file, so this file may import NOTHING
 * from the registry (`no-circular`, `pnpm check:arch`) — and the registry module sits at the
 * god-module line ceiling, which is why the entries do not simply live there. The two shapes
 * below are structurally the registry's `Check` / `ObjectSchema`; a schema here passes through
 * unknown keys exactly as every registry schema does (see that file's "why no zod").
 *
 * Each asserts only what `mergeJobTracker.ts` / `mergeJobBadge.ts` read: the 202's `jobId`,
 * the status body's `job` (null on the absent shape) with its `state` and attempt list, and
 * the bank-shrinks 202's `jobId` + `committed`.
 */

interface FieldCheck {
  check(value: unknown, path: string, issues: string[]): void;
}

interface Schema {
  readonly fields: Record<string, FieldCheck>;
  validate(value: unknown, issues: string[]): void;
}

function typeOf(name: "string" | "number" | "boolean"): FieldCheck {
  return {
    check(value, path, issues) {
      if (typeof value !== name) issues.push(`${path}: expected ${name}, got ${value === null ? "null" : typeof value}`);
    },
  };
}
const str = typeOf("string");
const num = typeOf("number");
const bool = typeOf("boolean");

function object(fields: Record<string, FieldCheck>): Schema {
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

function nested(schema: Schema): FieldCheck {
  return {
    check(value, path, issues) {
      const inner: string[] = [];
      schema.validate(value, inner);
      for (const issue of inner) issues.push(`${path}.${issue}`);
    },
  };
}

function nullable(inner: FieldCheck): FieldCheck {
  return { check: (value, path, issues) => { if (value !== null) inner.check(value, path, issues); } };
}

function arrayOf(inner: FieldCheck): FieldCheck {
  return {
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array, got ${value === null ? "null" : typeof value}`);
        return;
      }
      value.forEach((item, i) => inner.check(item, `${path}[${i}]`, issues));
    },
  };
}

/** `POST /api/workspaces/:id/merge?async=1` → `{ accepted: true, jobId, workspaceId, statusUrl }`. */
export const mergeAccepted: Schema = object({ accepted: bool, jobId: str, statusUrl: str });

const mergeJob = object({ jobId: str, state: str, startedAt: str, attempts: arrayOf(nested(object({ attempt: num }))) });

/**
 * `GET /api/workspaces/:id/merge-status` → `describeLiveMergeJob` (job present) or
 * `describeAbsentMergeJob` (`job: null`, plus `outcome`/`message`). The root asserts only the
 * discriminator; the live job's fields are checked when it is there.
 */
export const mergeStatus: Schema = object({ job: nullable(nested(mergeJob)) });

/** `POST /api/workspaces/:id/merge/bank-shrinks` → `{ applied, committed, jobId, statusUrl }`. */
export const bankShrinksAccepted: Schema = object({
  jobId: str,
  committed: str,
  applied: arrayOf(nested(object({ key: str, to: num }))),
});

/** The registry entries, spread into `API_RESPONSE_SCHEMAS` (structurally `ApiResponseRoute`). */
export const MERGE_JOB_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; template: string; schema: Schema }> = [
  { method: "POST", template: "/api/workspaces/:id/merge", schema: mergeAccepted },
  { method: "GET", template: "/api/workspaces/:id/merge-status", schema: mergeStatus },
  { method: "POST", template: "/api/workspaces/:id/merge/bank-shrinks", schema: bankShrinksAccepted },
];
