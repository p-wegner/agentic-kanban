// @covers mcp-server.fire.webhook [error,config,risk]
//
// A status-change mutation (move_issue) fires the project's outbound webhook
// BEST-EFFORT, but only after the configured URL passes a LOOPBACK-ONLY egress
// check (validateWebhookUrl, outbound-webhook.ts:44). That check is the single
// SSRF-ish boundary against a malicious `outbound_webhook_url_<projectId>` pref:
// a non-loopback / non-http(s) host must NOT receive a POST. This file asserts
//   1. a loopback pref → exactly one POST to that loopback URL with the
//      issue.status_changed payload,
//   2. a non-loopback ("foreign host") pref → NO fetch leaves the process (the
//      egress is refused, not coerced),
//   3. a non-http(s) scheme (file://) pref → NO fetch,
//   4. the mutation itself SUCCEEDS regardless of the webhook outcome (even when
//      the loopback POST rejects).
//
// fireWebhook (outbound-webhook.ts:65) calls fetch synchronously inside the
// handler, so by the time invoke() resolves the spy has already been (not) hit —
// no fixed-sleep needed; the negative cases assert 0 calls deterministically.

import { describe, expect, it, vi, afterEach } from "vitest";
import * as schema from "@agentic-kanban/shared/schema";
import { registerMoveIssue } from "../../tools/move-issue.js";
import { setupTool } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

/** Seed a project + a movable issue and set the project's outbound webhook pref. */
async function seedWithWebhookPref(
  db: TestDb,
  webhookUrl: string,
): Promise<{ issueId: string; projectId: string }> {
  const { projectId, statusIds } = await seedProject(db);
  const issue = await seedIssue(db, projectId, statusIds["Todo"]);
  await db.insert(schema.preferences).values({
    key: `outbound_webhook_url_${projectId}`,
    value: webhookUrl,
    updatedAt: new Date().toISOString(),
  });
  return { issueId: issue.id, projectId };
}

describe("move_issue fires the outbound webhook loopback-only", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the issue.status_changed payload to a LOOPBACK webhook URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const { invoke, db } = setupTool(registerMoveIssue);
    const { issueId, projectId } = await seedWithWebhookPref(
      db,
      "http://127.0.0.1:9099/board-hook",
    );

    const result = await invoke({ issueId, statusName: "In Review" });

    // The mutation succeeded.
    expect(result.content[0].text).toContain('"movedTo": "In Review"');

    // The webhook fired exactly once, to the configured loopback target.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:9099/board-hook");
    expect(init).toMatchObject({ method: "POST" });

    // The payload is the issue.status_changed wire shape for THIS issue/project.
    const payload = JSON.parse(String((init as RequestInit).body));
    expect(payload).toMatchObject({
      event: "issue.status_changed",
      issueId,
      projectId,
      newStatusName: "In Review",
    });
  });

  it("REFUSES a non-loopback (foreign) host — no POST leaves the process", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const { invoke, db } = setupTool(registerMoveIssue);
    const { issueId } = await seedWithWebhookPref(
      db,
      "http://attacker.example.com/exfil",
    );

    const result = await invoke({ issueId, statusName: "In Review" });

    // Egress boundary: the foreign host is NEVER contacted, not coerced to one.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Mutation still succeeds — webhook gating is independent of the move.
    expect(result.content[0].text).toContain('"movedTo": "In Review"');
  });

  it("REFUSES a non-http(s) scheme (file://) — no fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const { invoke, db } = setupTool(registerMoveIssue);
    const { issueId } = await seedWithWebhookPref(db, "file:///etc/passwd");

    const result = await invoke({ issueId, statusName: "In Review" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('"movedTo": "In Review"');
  });

  it("succeeds even when the loopback webhook POST rejects (best-effort)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const { invoke, db } = setupTool(registerMoveIssue);
    const { issueId } = await seedWithWebhookPref(db, "http://localhost:1/down");

    const result = await invoke({ issueId, statusName: "In Review" });

    // Fired (loopback passed the gate) but the move is unaffected by the failure.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('"movedTo": "In Review"');
  });
});
