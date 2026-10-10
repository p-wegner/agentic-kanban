/**
 * Response schemas for the Runners view's worker/placement endpoints (#1089), spread into
 * `API_RESPONSE_SCHEMAS`.
 *
 * Self-contained on purpose, same shape as `mergeJobSchemas.ts`: the registry imports this
 * file, so this file may import NOTHING from the registry (`no-circular`, `pnpm check:arch`)
 * — and the registry module sits at the god-module line ceiling, which is why this section
 * was moved out rather than grown in place.
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
const trueLiteral: FieldCheck = { check: (value, path, issues) => { if (value !== true) issues.push(`${path}: expected true, got ${value === null ? "null" : typeof value}`); } };

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

/** The value is an array; its elements are not checked (mirrors the registry's `anyArray`). */
const anyArray: FieldCheck = {
  check(value, path, issues) {
    if (!Array.isArray(value)) issues.push(`${path}: expected array, got ${value === null ? "null" : typeof value}`);
  },
};

/**
 * `GET /api/workers/connect-info` → `routes/workers.ts`'s inline projection (no shared DTO).
 * The Connect tab renders `fleetConfigured` to choose its two messages and `steps` as the
 * whole runbook body; the other fields (ports/hosts/version) are display-only strings the
 * panel never branches on, so per the registry's convention they stay unasserted.
 */
const workerConnectStep = looseObject({ title: str, detail: str, commands: anyArray, where: str });
const workerConnectInfo: Schema = looseObject({
  fleetConfigured: bool,
  boardUrl: str,
  steps: arrayOf(nested(workerConnectStep)),
});

/**
 * `GET /api/workers/explain` → `{ explanation: PlacementExplanation }` — both the project-level
 * and per-issue variants answer this shape (`explainPlacement`/`explainIssuePlacement`,
 * `lib/placement-explain.types.ts`). The Dispatch Log tab's "Explain" box reads `summary`,
 * `chain` (each entry's `id`/`title`/`outcome`/`detail`), `decidedBy` and `agreesWithResolver`.
 */
const workerExplainResponse: Schema = looseObject({
  explanation: nested(
    looseObject({
      summary: str,
      chain: arrayOf(nested(looseObject({ id: str, title: str, outcome: str, detail: str }))),
      decidedBy: nullable(str),
      agreesWithResolver: bool,
    }),
  ),
});

/**
 * `GET /api/workers/placements` → `{ placements: SessionPlacementRecord[] }`
 * (`services/placement-explain.service.ts`). Two panels share this one endpoint: the Runners
 * tab's "current work" line (`workspaceId`/`branch`/`issueNumber`/`issueTitle`/`status`/
 * `workerId`/`startedAt`/`endedAt`) and the Dispatch Log tab's full row
 * (adds `sessionId`/`executor`/`placement`/`workerName`/`placementReason`/`placementDetail`).
 */
const sessionPlacementRow = looseObject({
  sessionId: str,
  workspaceId: str,
  branch: nullable(str),
  issueNumber: nullable(num),
  issueTitle: nullable(str),
  status: str,
  executor: str,
  startedAt: str,
  endedAt: nullable(str),
  exitCode: nullable(num),
  endedBy: nullable(str),
  placement: str,
  workerId: nullable(str),
  workerName: nullable(str),
  placementReason: nullable(str),
  placementDetail: nullable(str),
});
const sessionPlacements: Schema = looseObject({ placements: arrayOf(nested(sessionPlacementRow)) });

/** `POST /api/workers/incoming/land` and `/discard` → `{ ok: true, ... }`
 *  (`routes/workers.ts`). Neither Git Transport tab caller reads a field off the result —
 *  it just reloads the list on success — so this asserts only that the request succeeded. */
const incomingRefActionResult: Schema = looseObject({ ok: trueLiteral });

/** The registry entries, spread into `API_RESPONSE_SCHEMAS` (structurally `ApiResponseRoute`). */
export const WORKER_RUNNERS_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; template: string; schema: Schema }> = [
  { method: "GET", template: "/api/workers/connect-info", schema: workerConnectInfo },
  { method: "GET", template: "/api/workers/explain", schema: workerExplainResponse },
  { method: "GET", template: "/api/workers/placements", schema: sessionPlacements },
  { method: "POST", template: "/api/workers/incoming/land", schema: incomingRefActionResult },
  { method: "POST", template: "/api/workers/incoming/discard", schema: incomingRefActionResult },
];
