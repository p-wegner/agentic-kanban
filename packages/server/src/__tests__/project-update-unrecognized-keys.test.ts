// @gate:always-run
/**
 * #992 — `PATCH /api/projects/:id` returned **200 with the full project object** for a body
 * whose fields nobody read. The #987 defect one route over: `updateProject` picks fields out of
 * the body and ignores the rest, so a caller that sent a renamed, misremembered or stale field
 * got a success response and a project row that did not change.
 *
 * The route now 422s with nothing applied. The reason that is safe to do to a
 * previously-permissive endpoint is the first two tests below, not the others — see their
 * comments. `@gate:always-run` because they read source files they do not import.
 *
 * ## The caller sweep, recorded here because a guard cannot see most of it
 *
 * Done at landing time (2026-09-02), the ticket's step 3:
 *
 *  - **The route's only client caller** is `SettingsPanel.tsx`, whose body comes from
 *    `buildProjectPatchBody` — asserted directly below, since (unlike the issue side) that body
 *    is a plain object literal and is NOT typed `UpdateProjectRequest`, so type-checking alone
 *    would not have caught a stray key.
 *  - **`onboarding.service.ts`** calls `projectService.updateProject(projectId, { setupScript })`
 *    — the SERVICE, not the route, so the 422 cannot reach it; `setupScript` is recognized in
 *    any case.
 *  - **MCP** has ten project tools (`register`/`create`/`init`/`relocate`/`unregister`/repo
 *    add+remove/list×2/cleanup) and NONE of them updates project fields through this route.
 *  - **The CLI** has no `project update` command; `register`, `relocate` and `cleanup` write
 *    through their own repository functions.
 *  - **The narrower-second-endpoint check** (the ticket's step 4, which on the issue side found
 *    the bulk route): `PATCH /api/projects/:id/{repos,scripts,statuses}/:id` are DIFFERENT
 *    resources with their own handlers and their own bodies — they do not share this field
 *    table, so accepting the wider set there is not a risk. They have the same class of hole
 *    and are out of scope for this ticket.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RECOGNIZED_PROJECT_UPDATE_KEYS,
  RECOGNIZED_PROJECT_PATCH_KEYS,
  unrecognizedProjectUpdateKeys,
  applyProjectUpdateFields,
} from "../services/project-update-fields.js";

const UPDATE_PROJECT_REQUEST_SRC = fileURLToPath(
  new URL("../../../shared/src/types/api/project.ts", import.meta.url),
);
const CLIENT_PATCH_BODY_SRC = fileURLToPath(
  new URL("../../../client/src/lib/settingsPanelState.ts", import.meta.url),
);

/** Read a file with CRLF normalised at the read (#888) — every match below is newline-anchored. */
function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
}

/** The declared field names of the `UpdateProjectRequest` interface, read from source. */
function declaredUpdateProjectRequestFields(): string[] {
  const src = readSource(UPDATE_PROJECT_REQUEST_SRC);
  const start = src.indexOf("export interface UpdateProjectRequest {");
  expect(start, "UpdateProjectRequest interface not found — this guard is reading the wrong file").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  // Property lines only: `  name?: type;`. Doc comments and blank lines do not match.
  return [...body.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]!);
}

/** The keys the settings panel actually PATCHes, read from `buildProjectPatchBody`'s source. */
function clientPatchBodyKeys(): string[] {
  const src = readSource(CLIENT_PATCH_BODY_SRC);
  const start = src.indexOf("export function buildProjectPatchBody(");
  expect(start, "buildProjectPatchBody not found — this guard is reading the wrong file").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]!);
}

describe("#992: the recognized-key set is derived, not hand-listed", () => {
  /**
   * THE test, half one. The ticket's step 2: the 422 is safe exactly as long as the wire
   * contract is a SUBSET of what the server reads, and it stops being safe the moment someone
   * adds a field to the interface without teaching the service.
   *
   * The sweep at landing time found one already: `defaultSkillId` was read by the server and
   * sent by the settings panel but absent from `UpdateProjectRequest`. It was added in the same
   * commit — under the old permissive route an undeclared field was harmless, and under the new
   * one it is exactly the shape of mistake that breaks a legitimate save.
   */
  it("recognizes every field the UpdateProjectRequest contract declares", () => {
    const declared = declaredUpdateProjectRequestFields();
    expect(declared.length).toBeGreaterThan(10);
    const unreadable = declared.filter((f) => !RECOGNIZED_PROJECT_PATCH_KEYS.has(f));
    expect(
      unreadable,
      "a field a typed client can send that the route would now 422 — add it to "
      + "PROJECT_UPDATE_FIELDS (or to the two applied outside the table: defaultBranch in "
      + "updateProject, servicesConfig in the route), or remove it from UpdateProjectRequest",
    ).toEqual([]);
  });

  /**
   * THE test, half two — and the half the issue side did not need. `buildProjectPatchBody`
   * returns a plain object literal, NOT a value typed `UpdateProjectRequest`, so the contract
   * check above proves nothing about what the one real client actually sends. This reads that
   * function's own source.
   */
  it("recognizes every key the settings panel's PATCH body actually sends", () => {
    const sent = clientPatchBodyKeys();
    expect(sent.length).toBeGreaterThan(5);
    const wouldBeRejected = sent.filter((k) => !RECOGNIZED_PROJECT_PATCH_KEYS.has(k));
    expect(
      wouldBeRejected,
      "the settings panel sends a key the route would now 422 — every project settings save "
      + "would fail with nothing applied",
    ).toEqual([]);
  });

  it("does not recognize keys the contract does not declare", () => {
    // The converse direction. Not a defect on its own — a server-only field simply has no typed
    // client — so this asserts the specific pair that motivated the ticket rather than set
    // equality, exactly as #987's guard does.
    const declared = new Set(declaredUpdateProjectRequestFields());
    for (const key of RECOGNIZED_PROJECT_PATCH_KEYS) {
      expect(declared.has(key), `${key} is applied by the server but absent from UpdateProjectRequest`).toBe(true);
    }
  });

  it("keeps servicesConfig out of the SERVICE's set and in the ROUTE's", () => {
    // The single/bulk split of #987, in its project-side form. `servicesConfig` is validated and
    // persisted by the route so malformed config 422s before any other field is written; the
    // service never reads it. Collapsing the two sets would either make the service accept a
    // field it cannot apply, or make the route reject one it can.
    expect(RECOGNIZED_PROJECT_PATCH_KEYS.has("servicesConfig")).toBe(true);
    expect(RECOGNIZED_PROJECT_UPDATE_KEYS.has("servicesConfig")).toBe(false);
    for (const key of RECOGNIZED_PROJECT_UPDATE_KEYS) {
      expect(RECOGNIZED_PROJECT_PATCH_KEYS.has(key), `${key} is readable by the service but not by the route`).toBe(true);
    }
  });

  it("names exactly the unread keys, and nothing when every field lands", () => {
    expect(unrecognizedProjectUpdateKeys({ name: "x", servicesConfig: null })).toEqual([]);
    // The real shapes that motivated #987/#992: a plausible-looking field nobody reads.
    expect(unrecognizedProjectUpdateKeys({ repoPath: "C:/tmp/x" })).toEqual(["repoPath"]);
    expect(unrecognizedProjectUpdateKeys({ name: "x", status: "Done" })).toEqual(["status"]);
  });

  it("applies only the keys the body carries", () => {
    const updates: Record<string, unknown> = { updatedAt: "2026-09-02T00:00:00.000Z" };
    applyProjectUpdateFields({ setupScript: "", maxRetries: "3", symlinkDirs: ["a", 2] }, updates);
    // `setupScript: ""` clears the column rather than storing an empty string the server would
    // then treat as "configured" — the normalisation the settings panel relies on.
    expect(updates.setupScript).toBeNull();
    expect(updates.maxRetries).toBe(3);
    // Non-strings are filtered out of symlinkDirs, and the column holds JSON text.
    expect(updates.symlinkDirs).toBe(JSON.stringify(["a"]));
    // Nothing else was invented — a PATCH that carries three fields must write three fields.
    expect(Object.keys(updates).sort()).toEqual(["maxRetries", "setupScript", "symlinkDirs", "updatedAt"]);
  });

  it("rejects a symlinkDirs string that is not JSON, rather than silently ignoring it", () => {
    expect(() => applyProjectUpdateFields({ symlinkDirs: "node_modules" }, {})).toThrow(/JSON array of strings/);
  });
});
