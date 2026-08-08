/**
 * #361 — a merged, gate-approved, Done pipeline unit was relaunched into a whole second workspace.
 *
 * Measured on kassenbuch step-6 (issue #6, merge `cd4aae9`, `mergedAt` 20:06:58, gate approved
 * 20:11:44, ticket Done, workspace closed):
 *
 * | time (UTC) | event |
 * |---|---|
 * | 20:18:22 | issue #6 -> In Progress, loop `openTickets` -> 2 |
 * | 20:22:16 | relaunch workspace `…-skel-r2` created |
 * | 20:24:45 | issue #6 -> Done, `openTickets` -> 1 |
 * | 20:25:22 | `-r2` workspace last touched, left idle, never merged |
 *
 * WHAT set the status at 20:18:22 is still unproven, and the ticket says not to fix against a
 * guessed cause. This test does not need it: `reopenRetryBranch` (the only producer of the `-r2`
 * suffix) lives in `monitor-auto-start`, so the relaunch definitely came from the reopen-retry path
 * (#265) — and for a plugin-loop unit that path is wrong whatever fed it. The loop dedupes on
 * `external_key` and never re-plans a unit that already has a ticket, so work done in a second
 * workspace can never be represented in the loop, while it inflates `openTickets` (the value the
 * monitor gates advancing on) and leaves a branch and worktree behind.
 *
 * Testing the PREDICATE rather than `runAutoStart`: the guard is one condition, and `runAutoStart`
 * needs the whole monitor's DB surface plus an HTTP launch to exercise. The comment above records
 * why the condition is correct; this pins that loop keys are recognised and ordinary tickets are not
 * caught by it — a guard that also declined normal reopen-retries would silently break #265.
 */
import { describe, expect, it } from "vitest";
import { parsePluginLoopUnitKey, pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";

describe("#361: the reopen-retry guard's predicate", () => {
  it("recognises the exact key shape the kassenbuch unit carried", () => {
    const key = pluginLoopUnitKey("pm-pipeline", "pipeline", "step-6:v1");
    expect(key).toBe("plugin-loop:pm-pipeline:pipeline:step-6:v1");
    expect(parsePluginLoopUnitKey(key)).toEqual({
      pluginSlug: "pm-pipeline", loopName: "pipeline", unitId: "step-6:v1",
    });
  });

  it("does NOT catch an ordinary ticket, so #265's reopen-retry still works", () => {
    // Every one of these is a legitimate reopen-retry candidate and must stay one.
    for (const externalKey of [null, undefined, "", "JIRA-123", "gh-456", "plugin-loop", "plugin-loop:"]) {
      expect(parsePluginLoopUnitKey(externalKey), `"${String(externalKey)}" must not be read as a loop unit`).toBeNull();
    }
  });

  it("recognises a unit id containing colons — the pipeline's own versioned ids do", () => {
    // `step-6:v1` puts a colon in the TAIL; a naive 4-way split would misparse it and the guard
    // would then let exactly the observed relaunch through.
    expect(parsePluginLoopUnitKey("plugin-loop:reqextract:extract:billing:r3")?.unitId).toBe("billing:r3");
  });
});
