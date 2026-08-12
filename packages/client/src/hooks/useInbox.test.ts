import { describe, expect, it } from "vitest";
import { inboxCountsByProject, type InboxItem } from "./useInbox.js";
import { waitingChipLabel } from "../components/WaitingOnYouChip.js";

/**
 * #411 — a waiting gate was invisible outside the Plugins view. MEASURED: pmqa's pipeline sat
 * at a gate for 1d 3h while its own Board view showed "Completed 17 (all done)" and the project
 * switcher rendered it identically to 18 idle ones.
 */

function item(projectId: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: "plugin-gate",
    projectId,
    projectName: projectId,
    title: "Approve step 7/9 — Test & QA?",
    detail: null,
    link: { view: "plugin-views" },
    createdAt: null,
    ...over,
  };
}

describe("inbox counts by project (#411)", () => {
  it("groups items so the switcher can badge each project", () => {
    const counts = inboxCountsByProject([item("a"), item("b"), item("a", { kind: "plugin-merge" })]);
    expect([...counts]).toEqual([["a", 2], ["b", 1]]);
  });

  it("counts EVERY kind, not just gates", () => {
    // A merge that never landed (#440) blocks a human exactly as a gate does; the badge
    // that only counted gates is what left two projects waiting a week unseen.
    const counts = inboxCountsByProject([
      item("p", { kind: "plugin-merge" }),
      item("p", { kind: "agent-question" }),
      item("p", { kind: "tool-approval" }),
    ]);
    expect(counts.get("p")).toBe(3);
  });

  it("is empty while the inbox has not loaded yet", () => {
    expect(inboxCountsByProject(null).size).toBe(0);
  });
});

describe("waiting chip label (#411)", () => {
  it("keeps the identifying head of a long gate question", () => {
    // The live pm-pipeline gate — the warnings run past any chip width, and truncating
    // the raw string would show a fragment of a warning instead of WHICH step waits.
    const label = waitingChipLabel(
      "Approve step 7/9 — Test & QA (plan + execution) (v1)? ⚠ 8 of 50 acceptance criteria are UNEXECUTED — approving waives them and needs a written reason.",
    );
    expect(label).toBe("Approve step 7/9");
  });

  it("caps a long unbroken title rather than overflowing the header", () => {
    expect(waitingChipLabel("x".repeat(100))).toHaveLength(42);
  });

  it("falls back to a readable label when the title has no head", () => {
    expect(waitingChipLabel("? nothing before the question mark")).toBe("Decision waiting");
  });
});
