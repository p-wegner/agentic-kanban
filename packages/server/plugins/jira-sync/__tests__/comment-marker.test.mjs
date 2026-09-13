import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeComment, hasAttributionMarker } from "../tools/lib/comment-marker.mjs";

test("attributeComment: appends a marker naming the board comment it came from", () => {
  const attributed = attributeComment("Looks good", { boardCommentId: "c7" });
  assert.equal(attributed, "Looks good\n\n_Synced from agentic-kanban comment c7_");
});

test("hasAttributionMarker: detects a comment that already carries the marker", () => {
  const attributed = attributeComment("Looks good", { boardCommentId: "c7" });
  assert.equal(hasAttributionMarker(attributed), true);
  assert.equal(hasAttributionMarker("a plain comment"), false);
  assert.equal(hasAttributionMarker(null), false);
});
