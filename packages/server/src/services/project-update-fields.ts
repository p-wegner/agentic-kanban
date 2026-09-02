/**
 * The PATCH-body field vocabulary for a project update: which keys land on the row, how each
 * one lands, and therefore which keys nobody reads.
 *
 * The sibling of `issue-update-fields.ts`, and deliberately the same shape, because it exists
 * for the same reason (#992, the #987 defect one route over): `PATCH /api/projects/:id`
 * forwarded its whole body to a service that picked fields out of it and ignored the rest,
 * answering **200 with the full project object** either way. A caller that sent a renamed,
 * misremembered or stale field got a success response and a project row that did not change.
 *
 * The table IS the recognized-key list. A hand-written `RECOGNIZED_KEYS` beside an `if` chain
 * is two descriptions of one thing, and the one that drifts is the one that 422s a field that
 * works — which is the failure mode that makes tightening a permissive endpoint dangerous.
 *
 * Pure: no DB, no clock beyond the `now` passed in, no events. `routes/projects.ts` needs the
 * key SET without needing the project service at all.
 */
import { ProjectError } from "./project-error.js";

/**
 * Normalise `symlinkDirs` to the JSON-array-of-strings TEXT the column holds.
 *
 * Accepts the three shapes the wire contract allows (`string | string[] | null`) and throws
 * `BAD_REQUEST` for a string that is not JSON. Note the deliberate gap kept from the original
 * `if` chain: a JSON string that parses to a NON-array (e.g. `"42"`) leaves the column
 * untouched rather than throwing — changing that would be a behaviour change riding on a
 * ticket about unread keys, so it is preserved and named here instead.
 */
function normalizeSymlinkDirs(value: unknown, updates: Record<string, unknown>): void {
  if (value === null || value === "") {
    updates.symlinkDirs = null;
    return;
  }
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProjectError("symlinkDirs must be a JSON array of strings", "BAD_REQUEST");
    }
    if (Array.isArray(parsed)) {
      updates.symlinkDirs = JSON.stringify(parsed.filter((d: unknown) => typeof d === "string"));
    }
    return;
  }
  if (Array.isArray(value)) {
    updates.symlinkDirs = JSON.stringify(value.filter((d: unknown) => typeof d === "string"));
  }
}

/**
 * Body key -> how it lands on the row, for every field whose application is PURE.
 *
 * `defaultBranch` is deliberately absent: applying it requires an async `branchExists` check
 * against the project's checkout, so it stays in `updateProject` and is added to
 * {@link RECOGNIZED_PROJECT_UPDATE_KEYS} explicitly — the same treatment `checklist`/`pinned`/
 * `milestoneId` get on the issue side.
 */
const PROJECT_UPDATE_FIELDS: Record<string, (value: unknown, updates: Record<string, unknown>) => void> = {
  name: (v, u) => { u.name = v; },
  description: (v, u) => { u.description = v; },
  color: (v, u) => { u.color = v; },
  setupScript: (v, u) => { u.setupScript = v || null; },
  setupBlocking: (v, u) => { u.setupBlocking = !!v; },
  setupEnabled: (v, u) => { u.setupEnabled = !!v; },
  teardownScript: (v, u) => { u.teardownScript = v || null; },
  autoRetryFlakes: (v, u) => { u.autoRetryFlakes = !!v; },
  maxRetries: (v, u) => { u.maxRetries = Number(v); },
  symlinkEnabled: (v, u) => { u.symlinkEnabled = !!v; },
  symlinkDirs: normalizeSymlinkDirs,
  defaultSkillId: (v, u) => { u.defaultSkillId = typeof v === "string" && v ? v : null; },
};

/** The keys `updateProject` actually reads (#992). */
export const RECOGNIZED_PROJECT_UPDATE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(PROJECT_UPDATE_FIELDS),
  "defaultBranch",
]);

/**
 * The keys `PATCH /api/projects/:id` accepts — a strict SUPERSET of what the service reads.
 *
 * `servicesConfig` is validated and persisted by the ROUTE, not by `updateProject`, so that it
 * can 422 on malformed config before any other field is written. It is therefore a key the
 * endpoint recognises and the service does not, which is exactly the single/bulk split
 * `RECOGNIZED_BULK_ISSUE_UPDATE_KEYS` expresses on the issue side — and the reason these are
 * two constants rather than one: rejecting `servicesConfig` at the service, or accepting it at
 * a caller that cannot apply it, would each be a defect.
 */
export const RECOGNIZED_PROJECT_PATCH_KEYS: ReadonlySet<string> = new Set([
  ...RECOGNIZED_PROJECT_UPDATE_KEYS,
  "servicesConfig",
]);

/**
 * Which of `body`'s keys nobody will read (#992). Empty means every field will be applied.
 *
 * Returned rather than thrown so the caller decides the status code — the route 422s (the #874
 * precedent: a write that reports success for work it did not do is the defect), while an
 * internal caller assembling its own body can simply assert it is empty.
 */
export function unrecognizedProjectUpdateKeys(
  body: Record<string, unknown>,
  recognized: ReadonlySet<string> = RECOGNIZED_PROJECT_PATCH_KEYS,
): string[] {
  return Object.keys(body).filter((key) => !recognized.has(key));
}

/**
 * Apply every PURE field of a project PATCH body to a column-update object.
 *
 * `updatedAt` is the caller's to set — `updateProject` seeds it before calling — so this
 * function only ever adds fields the body actually carried.
 */
export function applyProjectUpdateFields(
  body: Record<string, unknown>,
  updates: Record<string, unknown>,
): void {
  for (const [key, apply] of Object.entries(PROJECT_UPDATE_FIELDS)) {
    if (body[key] !== undefined) apply(body[key], updates);
  }
}
