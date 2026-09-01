// @gate:always-run
/**
 * #987 — `PATCH /api/issues/:id` returned **200 with the full issue object** for a body whose
 * fields nobody read.
 *
 * Observed live 2026-09-01: three tickets closed with `{"status":"Done"}` (the field is
 * `statusId`) were still `Todo` hours later, and the card context menu's own "Move to status"
 * had been PATCHing `{statusName}` — a UI action that did nothing, silently, with no error
 * toast because the request succeeded. It is the #874 failure class (a write reporting success
 * for work it did not do), and worse here than for a preference: an agent that believes a
 * ticket is Done stops tracking it.
 *
 * The route now 422s with nothing applied. The reason that is safe to do to a
 * previously-permissive endpoint is the FIRST test below, not the others — see its comment.
 *
 * `@gate:always-run` because that first test reads a source file it does not import.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RECOGNIZED_ISSUE_UPDATE_KEYS,
  RECOGNIZED_BULK_ISSUE_UPDATE_KEYS,
  unrecognizedIssueUpdateKeys,
  buildSharedIssueUpdate,
} from "../services/issue-update-fields.js";

const UPDATE_ISSUE_REQUEST_SRC = fileURLToPath(
  new URL("../../../shared/src/types/api/issue.ts", import.meta.url),
);

/** The declared field names of the `UpdateIssueRequest` interface, read from source. */
function declaredUpdateIssueRequestFields(): string[] {
  // CRLF-normalised at the read (#888): this compares against newline-bearing patterns
  // (a newline-anchored slice and a multiline `^` regex), which are green on master and red
  // in every worktree gate under core.autocrlf=true.
  const src = readFileSync(UPDATE_ISSUE_REQUEST_SRC, "utf8").replace(/\r\n?/g, "\n");
  const start = src.indexOf("export interface UpdateIssueRequest {");
  expect(start, "UpdateIssueRequest interface not found — this guard is reading the wrong file").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  // Property lines only: `  name?: type;`. Doc comments and blank lines do not match.
  return [...body.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]);
}

describe("#987: the recognized-key set is derived, not hand-listed", () => {
  /**
   * THE test. The ticket's step 3 is explicit that "a wrong key list here 422s a legitimate
   * client, which is why this is a designed change and not a two-line guard" — and every
   * client PATCH body in `packages/client` is typed `UpdateIssueRequest`. So the 422 is safe
   * exactly as long as that contract is a subset of what the server reads, and it stops being
   * safe the moment someone adds a field to the interface without teaching the service.
   *
   * Verified by sweep at landing time (2026-09-01): 15 declared fields, 15 recognized keys, an
   * exact 1:1 match. The other callers cannot be caught by this guard and were checked by hand
   * — MCP `update_issue`/`move_issue` and the CLI write directly to the DB and never reach the
   * route; `backlog-markdown.service.ts` calls the service (not the route) and builds only
   * recognized keys anyway.
   */
  it("recognizes every field the UpdateIssueRequest contract declares", () => {
    const declared = declaredUpdateIssueRequestFields();
    expect(declared.length).toBeGreaterThan(10);
    const unreadable = declared.filter((f) => !RECOGNIZED_ISSUE_UPDATE_KEYS.has(f));
    expect(
      unreadable,
      "a field a typed client can send that the server would now 422 — add it to "
      + "SHARED_ISSUE_UPDATE_FIELDS (or to the three handled directly in updateIssue), or "
      + "remove it from UpdateIssueRequest",
    ).toEqual([]);
  });

  it("does not recognize keys the contract does not declare", () => {
    // The converse direction: a recognized key with no place in the contract is a field no
    // typed client can send. Not a defect on its own, so this asserts the specific pair that
    // motivated the ticket rather than set equality.
    const declared = new Set(declaredUpdateIssueRequestFields());
    for (const key of RECOGNIZED_ISSUE_UPDATE_KEYS) {
      expect(declared.has(key), `${key} is applied by the server but absent from UpdateIssueRequest`).toBe(true);
    }
  });

  it("keeps the bulk set narrower than the single-issue set, and says which three", () => {
    // `updateIssuesBulk` applies only the SHARED field table. Accepting `checklist`/`pinned`/
    // `milestoneId` on the bulk route would report success for a field it never reads — the
    // exact defect this ticket is about, reintroduced one endpoint over.
    const onlySingle = [...RECOGNIZED_ISSUE_UPDATE_KEYS].filter((k) => !RECOGNIZED_BULK_ISSUE_UPDATE_KEYS.has(k));
    expect(onlySingle.sort()).toEqual(["checklist", "milestoneId", "pinned"]);
  });
});

describe("#987: unrecognizedIssueUpdateKeys", () => {
  it("names the field that motivated the ticket", () => {
    // `{"status":"Done"}` — the body three real tickets were closed with. It returned 200.
    expect(unrecognizedIssueUpdateKeys({ status: "Done" })).toEqual(["status"]);
    // And the one the UI's own "Move to status" was sending.
    expect(unrecognizedIssueUpdateKeys({ statusName: "Done" })).toEqual(["statusName"]);
  });

  it("passes a body of entirely recognized fields", () => {
    expect(unrecognizedIssueUpdateKeys({ statusId: "s-1", title: "t", checklist: null })).toEqual([]);
  });

  it("reports the bulk-only rejection against the narrower set", () => {
    expect(unrecognizedIssueUpdateKeys({ pinned: true })).toEqual([]);
    expect(unrecognizedIssueUpdateKeys({ pinned: true }, RECOGNIZED_BULK_ISSUE_UPDATE_KEYS)).toEqual(["pinned"]);
  });

  it("reports every unrecognized key, not just the first", () => {
    // The route puts these in the response body because the fix is almost always a rename;
    // naming one of three would send the caller round the loop three times.
    expect(unrecognizedIssueUpdateKeys({ status: "Done", statusName: "Done", title: "kept" }).sort())
      .toEqual(["status", "statusName"]);
  });
});

describe("#987: the table refactor preserves buildSharedIssueUpdate's behaviour", () => {
  // The `if` chain became a table so the key set could be derived from it. That is only sound
  // if the table applies fields the same way the chain did.
  const NOW = "2026-09-01T12:00:00.000Z";

  it("applies a recognized field and always stamps updatedAt", () => {
    expect(buildSharedIssueUpdate({ title: "new" }, NOW)).toEqual({ updatedAt: NOW, title: "new" });
  });

  it("stamps statusChangedAt alongside statusId, and only then", () => {
    expect(buildSharedIssueUpdate({ statusId: "s-1" }, NOW))
      .toEqual({ updatedAt: NOW, statusId: "s-1", statusChangedAt: NOW });
    expect(buildSharedIssueUpdate({ title: "new" }, NOW)).not.toHaveProperty("statusChangedAt");
  });

  it("ignores an undefined field rather than writing undefined over the column", () => {
    expect(buildSharedIssueUpdate({ title: undefined }, NOW)).toEqual({ updatedAt: NOW });
  });

  it("applies an explicit null, which is how a nullable column is cleared", () => {
    // `undefined` means "not sent" and `null` means "clear it" — collapsing them would make
    // "clear the due date" unexpressible.
    expect(buildSharedIssueUpdate({ dueDate: null }, NOW)).toEqual({ updatedAt: NOW, dueDate: null });
  });

  it("drops an unrecognized key silently — the route, not the builder, is what reports it", () => {
    expect(buildSharedIssueUpdate({ status: "Done" }, NOW)).toEqual({ updatedAt: NOW });
  });
});
