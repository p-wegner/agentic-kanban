/**
 * Response schema for `GET /api/projects/:id/contributions` (#1264), spread into
 * `API_RESPONSE_SCHEMAS`.
 *
 * Self-contained, same shape as `workerRunnersSchemas.ts`: the registry imports this file, so
 * it may import NOTHING from the registry (`no-circular`), and the registry sits at the
 * god-module line ceiling. Asserts what the Contributions view renders: the actor label, and
 * every metric as a number or `null` (null renders as "–", never 0).
 */

interface FieldCheck {
  check(value: unknown, path: string, issues: string[]): void;
}

interface Schema {
  readonly fields: Record<string, FieldCheck>;
  validate(value: unknown, issues: string[]): void;
}

const kindOf = (value: unknown): string => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);

function typeOf(name: "string" | "number" | "boolean"): FieldCheck {
  return {
    check(value, path, issues) {
      if (typeof value !== name) issues.push(`${path}: expected ${name}, got ${kindOf(value)}`);
    },
  };
}
const str = typeOf("string");
const num = typeOf("number");
const bool = typeOf("boolean");
const nullableNum: FieldCheck = {
  check: (value, path, issues) => { if (value !== null) num.check(value, path, issues); },
};

function looseObject(fields: Record<string, FieldCheck>): Schema {
  return {
    fields,
    validate(value, issues) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        issues.push(`<root>: expected object, got ${kindOf(value)}`);
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

const actorRow = looseObject({
  actor: str, unset: bool,
  doneIssues: num, mergedIssues: num, workspaces: num,
  sessions: num, failedSessions: num, abortedSessions: num,
  mergedCommits: nullableNum, linesAdded: nullableNum, linesRemoved: nullableNum,
  inputTokens: nullableNum, outputTokens: nullableNum, costUsd: nullableNum, activeMs: nullableNum,
});

const contributionsResponse: Schema = looseObject({
  actors: {
    check(value, path, issues) {
      if (!Array.isArray(value)) {
        issues.push(`${path}: expected array, got ${kindOf(value)}`);
        return;
      }
      value.forEach((item, i) => {
        const inner: string[] = [];
        actorRow.validate(item, inner);
        for (const issue of inner) issues.push(`${path}[${i}].${issue}`);
      });
    },
  },
});

/** The registry entries, spread into `API_RESPONSE_SCHEMAS` (structurally `ApiResponseRoute`). */
export const CONTRIBUTION_ROUTES: ReadonlyArray<{ method: "GET"; template: string; schema: Schema }> = [
  { method: "GET", template: "/api/projects/:param/contributions", schema: contributionsResponse },
];