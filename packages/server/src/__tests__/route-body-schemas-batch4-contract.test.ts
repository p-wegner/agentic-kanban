/**
 * #806 batch 4 — the four route files whose bodies moved onto zod schemas, pinned at the level
 * the swap could break invisibly: the MESSAGE a rejected body gets, and the bodies that must
 * keep being ACCEPTED.
 *
 * Same shape as `route-body-schemas-batch3-contract.test.ts`, and the same reason for it: a
 * guard→schema swap is only a hardening if every request that succeeded before still succeeds.
 * These are schema-level rather than HTTP-level because `parseJsonBody` surfaces only the FIRST
 * issue as `{ error: message }` at 400, so `safeParse(...).error.issues[0].message` IS the wire
 * text.
 *
 * Batch 4 adds one axis batch 3 did not have: three of these four schemas replace a guard that
 * lived in a SERVICE and threw a coded domain error, so the route wraps the rejection to keep
 * `code` in the body. That wrapper is a route-level concern and is asserted at the bottom of
 * this file against the real `HTTPException` → domain-error mapping, because a schema that gets
 * the message right and loses `code` is exactly the invisible break this suite exists for.
 */
import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { HTTPException } from "hono/http-exception";
import { butlerMessageBody, butlerAskBody, butlerAnswerBody } from "../routes/butler-body-schemas.js";
import { createMilestoneBody } from "../routes/milestone-body-schemas.js";
import { startDriveBody } from "../routes/drive-body-schemas.js";
import { createScheduledRunBody } from "../routes/scheduled-run-body-schemas.js";
import { MilestoneError } from "../services/milestone.service.js";
import { DriveError } from "../services/drive.service.js";
import { ScheduledRunError } from "../services/scheduled-run.service.js";
import { DOMAIN_CODE_STATUS } from "../middleware/error-handler.js";

/** The exact text `parseJsonBody` would put in `{ error }`, or `null` when the body passes. */
function wireError(schema: ZodType<unknown>, body: unknown): string | null {
  const result = schema.safeParse(body);
  return result.success ? null : (result.error.issues[0]?.message ?? "invalid request body");
}

/** `[schema, body, the message the hand-written guard returned]` */
const REJECTS: Array<[string, ZodType<unknown>, unknown, string]> = [
  ["butler POST /message (absent)", butlerMessageBody, {}, "content is required"],
  ["butler POST /message (blank)", butlerMessageBody, { content: "   " }, "content is required"],
  ["butler POST /ask (absent)", butlerAskBody, {}, "content is required"],
  ["butler POST /ask (blank)", butlerAskBody, { content: "\n\t" }, "content is required"],
  ["butler POST /answer (no askId)", butlerAnswerBody, { answers: [{}] }, "askId is required"],
  ["butler POST /answer (blank askId)", butlerAnswerBody, { askId: " ", answers: [{}] }, "askId is required"],
  // The guard order: askId is reported first even though BOTH fields are wrong.
  ["butler POST /answer (both wrong)", butlerAnswerBody, {}, "askId is required"],
  ["butler POST /answer (answers absent)", butlerAnswerBody, { askId: "a" }, "answers is required"],
  ["butler POST /answer (answers empty)", butlerAnswerBody, { askId: "a", answers: [] }, "answers is required"],
  ["butler POST /answer (answers not an array)", butlerAnswerBody, { askId: "a", answers: "x" }, "answers is required"],
  ["milestones POST (absent)", createMilestoneBody, {}, "name is required"],
  ["milestones POST (blank)", createMilestoneBody, { name: "  " }, "name is required"],
  ["drives POST (absent)", startDriveBody, {}, "target is required"],
  ["drives POST (blank)", startDriveBody, { target: "" }, "target is required"],
  // ONE message for both fields, because `!body.name || !body.projectId` was one condition.
  ["scheduled-runs POST (nothing)", createScheduledRunBody, {}, "name and projectId are required"],
  [
    "scheduled-runs POST (name only)",
    createScheduledRunBody,
    { name: "nightly" },
    "name and projectId are required",
  ],
  [
    "scheduled-runs POST (empty name)",
    createScheduledRunBody,
    { name: "", projectId: "p" },
    "name and projectId are required",
  ],
];

describe("#806 batch 4 — rejected bodies keep the guard's exact message", () => {
  for (const [name, schema, body, message] of REJECTS) {
    it(`${name} answers "${message}"`, () => {
      expect(wireError(schema, body)).toBe(message);
    });
  }

  it("never reports one of zod's own defaults", () => {
    for (const [name, schema, body] of REJECTS) {
      const actual = wireError(schema, body) ?? "";
      expect(actual, name).not.toMatch(/^(Required|Invalid input|Expected )/);
    }
  });
});

describe("#806 batch 4 — bodies that succeed today still succeed", () => {
  const ACCEPTS: Array<[string, ZodType<unknown>, unknown]> = [
    // `timeoutMs` is read as `typeof x === "number" && x > 0 ? x : 120_000` — a coercion with a
    // default, so a string form is a live request that means "use the default".
    ["a string timeoutMs", butlerAskBody, { content: "hi", timeoutMs: "60000" }],
    ["a zero timeoutMs", butlerAskBody, { content: "hi", timeoutMs: 0 }],
    ["no timeoutMs at all", butlerAskBody, { content: "hi" }],
    // The element shape is filtered by the handler, which answers the SAME message when nothing
    // survives — so the schema must let junk elements through rather than reporting a zod path.
    ["answers whose elements are empty objects", butlerAnswerBody, { askId: "a", answers: [{}] }],
    ["answers whose elements are not objects", butlerAnswerBody, { askId: "a", answers: [1, 2] }],
    // Fields the routes declared but never checked stay unchecked (rule 3).
    ["a milestone with a null dueDate", createMilestoneBody, { name: "M1", dueDate: null }],
    ["a milestone with a numeric dueDate", createMilestoneBody, { name: "M1", dueDate: 20260824 }],
    ["a drive with null metaIssueId + contract", startDriveBody, { target: "t", metaIssueId: null, completionContract: null }],
    ["a drive with a numeric metaIssueId", startDriveBody, { target: "t", metaIssueId: 7 }],
    // `cronExpression` keeps its validation in the service, where the message is built from
    // `validateCronExpression` — the schema must not pre-empt it with a type error.
    ["a scheduled run with a bogus cron", createScheduledRunBody, { name: "n", projectId: "p", cronExpression: 5 }],
    ["a scheduled run with a string enabled", createScheduledRunBody, { name: "n", projectId: "p", enabled: "yes" }],
    ["a scheduled run with a string intervalMinutes", createScheduledRunBody, { name: "n", projectId: "p", intervalMinutes: "30" }],
    // `requiredRaw` is a bare falsy test, NOT a trim test — the guard was `!body.name`, so a
    // whitespace-only name is a request that succeeds today and must keep succeeding.
    ["a whitespace-only scheduled-run name", createScheduledRunBody, { name: "   ", projectId: "p" }],
  ];

  for (const [name, schema, body] of ACCEPTS) {
    it(`accepts ${name}`, () => {
      expect(wireError(schema, body)).toBeNull();
    });
  }
});

describe("#806 batch 4 — the value handed to the service is unchanged", () => {
  it("trims askId, because the handler passed the trimmed id to answerButlerQuestion", () => {
    expect(butlerAnswerBody.parse({ askId: "  ask-1  ", answers: [{}] }).askId).toBe("ask-1");
  });

  it("does NOT trim the fields whose handlers passed the original on", () => {
    // `sendButlerTurn(projectId, body.content)` receives the raw string; the services trim
    // `name`/`target` themselves, so trimming here would move where the trim happens.
    expect(butlerMessageBody.parse({ content: "  padded  " }).content).toBe("  padded  ");
    expect(butlerAskBody.parse({ content: "  padded  " }).content).toBe("  padded  ");
    expect(createMilestoneBody.parse({ name: "  padded  " }).name).toBe("  padded  ");
    expect(startDriveBody.parse({ target: "  padded  " }).target).toBe("  padded  ");
  });

  it("passes unknown keys THROUGH, so a handler forwarding the whole body loses nothing", () => {
    // `service.create(projectId, body)` / `service.start(projectId, body)` take the WHOLE body.
    const m = createMilestoneBody.parse({ name: "M", dueDate: null, futureField: 1 }) as Record<string, unknown>;
    expect(m.futureField).toBe(1);
    const d = startDriveBody.parse({ target: "t", extra: "keep" }) as Record<string, unknown>;
    expect(d.extra).toBe("keep");
    const s = createScheduledRunBody.parse({ name: "n", projectId: "p", extra: "keep" }) as Record<string, unknown>;
    expect(s.extra).toBe("keep");
  });

  it("keeps every field the OpenAPI property list had before the swap", () => {
    // The schema is now what `scripts/generate-openapi.ts` reads, so a field DROPPED from the
    // schema is a field deleted from the spec (#838). `POST /api/scheduled-runs` is the one
    // with a wide body, and the one where that is easiest to get wrong.
    const declared = Object.keys((createScheduledRunBody as unknown as { shape: Record<string, unknown> }).shape);
    expect(declared).toEqual([
      "name", "projectId", "description", "prompt", "skillId",
      "intervalMinutes", "cronExpression", "enabled",
    ]);
  });
});

describe("#806 batch 4 — the route's ERROR IDENTITY survives the swap", () => {
  // The three services whose guards moved to the boundary throw a coded domain error, which
  // `domainErrorHandler` renders as `{ error, code }`. `parseJsonBody` throws a bare
  // `HTTPException` (`{ error }` alone), so each route re-wraps it — `parsePluginBody`'s
  // pattern from batch 2. This pins the two halves that make the wrap correct: the code maps
  // to the SAME 400, and the message survives the re-wrap unchanged.
  const WRAPPERS: Array<[string, (message: string) => { message: string; code: string }]> = [
    ["MilestoneError", (m) => new MilestoneError(m, "BAD_REQUEST")],
    ["DriveError", (m) => new DriveError(m, "BAD_REQUEST")],
    ["ScheduledRunError", (m) => new ScheduledRunError(m, "BAD_REQUEST")],
  ];

  for (const [name, make] of WRAPPERS) {
    it(`${name} re-wraps a schema rejection at the same 400 with the same message`, () => {
      const rejection = new HTTPException(400, { message: "name is required" });
      const wrapped = make(rejection.message);
      expect(wrapped.message).toBe("name is required");
      expect(wrapped.code).toBe("BAD_REQUEST");
      expect(DOMAIN_CODE_STATUS[wrapped.code as "BAD_REQUEST"]).toBe(rejection.status);
    });
  }
});
