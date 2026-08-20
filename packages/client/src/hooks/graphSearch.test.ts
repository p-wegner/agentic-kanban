// @covers graph.searchByDescription [correctness, regression]
//
// #370's acceptance names this test explicitly: "A test that searches for a substring that appears
// ONLY in a description, never in a title, is the one that matters — that is the case a naive
// column-drop breaks silently."
//
// It broke silently. The payload diet took `description` off `/api/projects/:id/graph` (309,477 ->
// ~62,000 gzipped bytes) and the graph's filter became title-only, with `GraphNodes` still reading
// a `node.issue.description` that is now always undefined — a second clause that can never match.
// Bytes won, semantics lost, which is the trade #345 refused twice.
//
// The match now happens on the SERVER and only issue ids come back, so these cases are expressed
// as "what did the server say" rather than as a client-side haystack.
import { describe, expect, it } from "vitest";
import { graphNodeMatches } from "./useGraphSearch.js";

const ISSUE = "issue-1";
const TITLE = "Rebuild the merge queue";
/** The server matched this issue for a term that appears ONLY in its description. */
const MATCHED = new Set([ISSUE]);
const NO_MATCH = new Set<string>();

describe("graph search by description (#370)", () => {
  it("finds a substring that appears ONLY in the description", () => {
    // The premise of the whole ticket: this word is not in the title, so a title-only filter
    // silently loses the issue.
    expect(TITLE.toLowerCase()).not.toContain("worktree");
    expect(graphNodeMatches("worktree", ISSUE, TITLE, MATCHED)).toBe(true);
  });

  it("still finds a title match", () => {
    expect(graphNodeMatches("merge queue", ISSUE, TITLE, MATCHED)).toBe(true);
  });

  it("hides an issue the server did NOT match", () => {
    expect(graphNodeMatches("kubernetes", ISSUE, TITLE, NO_MATCH)).toBe(false);
  });

  it("matches everything on an empty query, without consulting the server's answer", () => {
    expect(graphNodeMatches("", ISSUE, TITLE, NO_MATCH)).toBe(true);
    expect(graphNodeMatches("   ", ISSUE, TITLE, NO_MATCH)).toBe(true);
  });

  it("falls back to TITLE matching while the search is unresolved", () => {
    // Debouncing, in flight, or failed. It must degrade to today's behaviour — never to an empty
    // graph, and never to FEWER results than the title-only filter it replaced.
    expect(graphNodeMatches("merge queue", ISSUE, TITLE, null)).toBe(true);
    expect(graphNodeMatches("worktree", ISSUE, TITLE, null)).toBe(false);
  });

  it("is case-insensitive in the fallback path too", () => {
    expect(graphNodeMatches("ReBuild THE Merge", ISSUE, TITLE, null)).toBe(true);
  });

  it("trims the query before matching, so a trailing space does not empty the graph", () => {
    expect(graphNodeMatches(" merge queue ", ISSUE, TITLE, null)).toBe(true);
  });
});
