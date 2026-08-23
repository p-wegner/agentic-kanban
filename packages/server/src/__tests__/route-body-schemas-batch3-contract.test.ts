/**
 * #806 batch 3 — the eleven route files whose bodies moved onto zod schemas, pinned at the
 * level the swap could break invisibly: the MESSAGE a rejected body gets, and the bodies that
 * must keep being ACCEPTED.
 *
 * The second half is the one that matters. A guard→schema swap is only a hardening if every
 * request that succeeded before still succeeds; the moment a schema validates *more* than the
 * guard did, a live caller starts getting a 400 it never got, and the refactor has changed the
 * contract while claiming not to. Each `accepts` case below is a body some caller can send
 * today — `{ estimate: 5 }`, `{ dryRun: "yes" }`, `{ runner: "junit" }`, `{ kind: "bogus" }` —
 * that the old handler passed straight through, coerced, or defaulted.
 *
 * These are schema-level rather than HTTP-level on purpose: `parseJsonBody` surfaces only the
 * FIRST issue as `{ error: message }` at 400 (see `middleware/parse-body.ts`), so
 * `safeParse(...).error.issues[0].message` IS the wire text, and asserting it here covers every
 * schema without standing up eleven route factories and their services.
 */
import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import {
  archiveDoneBody,
  createIssueBody,
  analyzeTouchedFilesBody,
  preflightBody,
  reposTouchedBody,
  issueTagBody,
  issueDependencyBody,
  issueArtifactBody,
  issueCommentBody,
  showdownBody,
} from "../routes/issue-body-schemas.js";
import { failurePatternBody, failurePatternIngestBody } from "../routes/failure-pattern-body-schemas.js";
import { flakyParseBody, flakyPinBody } from "../routes/flaky-test-body-schemas.js";
import { driveEnabledBody } from "../routes/drive-body-schemas.js";
import { pickWinnerBody } from "../routes/showdown-body-schemas.js";
import { voiceCaptureBody } from "../routes/voice-capture-body-schemas.js";
import { checkOverlapBody } from "../routes/project-analytics-body-schemas.js";
import { mergeQueueBody } from "../routes/merge-queue-body-schemas.js";
import { answerAgentQuestionBody } from "../routes/agent-question-body-schemas.js";
import { driveObstacleBody } from "../routes/drive-obstacle-body-schemas.js";
import { enhanceSkillBody } from "../routes/agent-skill-body-schemas.js";

/** The exact text `parseJsonBody` would put in `{ error }`, or `null` when the body passes. */
function wireError(schema: ZodType<unknown>, body: unknown): string | null {
  const result = schema.safeParse(body);
  return result.success ? null : (result.error.issues[0]?.message ?? "invalid request body");
}

/** `[schema, body, the message the hand-written guard returned]` */
const REJECTS: Array<[string, ZodType<unknown>, unknown, string]> = [
  ["issues POST /archive-done", archiveDoneBody, {}, "projectId is required"],
  ["issues POST /", createIssueBody, {}, "projectId is required"],
  ["issues POST / (blank title)", createIssueBody, { projectId: "p", title: "   " }, "title is required"],
  ["issues POST /:id/preflight", preflightBody, {}, "projectId is required"],
  ["issues PUT /:id/repos-touched", reposTouchedBody, {}, "reposTouched (array) is required"],
  ["issues POST /:id/tags", issueTagBody, {}, "tagId is required"],
  ["issues POST /:id/dependencies", issueDependencyBody, {}, "dependsOnId is required"],
  ["issues POST /:id/artifacts (no type)", issueArtifactBody, {}, "type and content are required"],
  // The COMBINED message must not split into a per-field one when only `content` is missing.
  ["issues POST /:id/artifacts (no content)", issueArtifactBody, { type: "image" }, "type and content are required"],
  ["issues POST /:id/comments", issueCommentBody, { body: "  " }, "body is required"],
  ["issues POST /:id/showdown (not an array)", showdownBody, {}, "contestants must be an array with at least 2 entries"],
  ["issues POST /:id/showdown (too few)", showdownBody, { contestants: [{}] }, "contestants must be an array with at least 2 entries"],
  ["failure-patterns POST /", failurePatternBody, { title: " " }, "title is required"],
  ["failure-patterns POST /ingest", failurePatternIngestBody, {}, "filePath is required"],
  ["flaky-tests POST /parse (no sessionId)", flakyParseBody, {}, "sessionId and output are required"],
  ["flaky-tests POST /parse (no output)", flakyParseBody, { sessionId: "s" }, "sessionId and output are required"],
  ["flaky-tests POST /pin", flakyPinBody, {}, "testName is required"],
  ["drive PUT /:projectId/drive (missing)", driveEnabledBody, {}, "enabled (boolean) is required"],
  ["drive PUT /:projectId/drive (wrong type)", driveEnabledBody, { enabled: "true" }, "enabled (boolean) is required"],
  ["showdowns POST /:id/pick-winner", pickWinnerBody, {}, "winnerWorkspaceId is required"],
  ["voice-capture POST", voiceCaptureBody, { transcript: "   " }, "transcript is required"],
  ["project-analytics POST /check-overlap (empty)", checkOverlapBody, { issueIds: [] }, "issueIds array is required"],
  ["merge-queue POST /", mergeQueueBody, { workspaceIds: [] }, "workspaceIds is required and must be a non-empty array"],
  [
    "agent-questions POST /answer",
    answerAgentQuestionBody,
    { questions: [], answers: [] },
    "workspaceId, questions[], and answers[] are required",
  ],
  ["drive-obstacles POST (bad kind)", driveObstacleBody, { kind: "nope" }, "kind must be one of: "],
  ["agent-skills POST /enhance", enhanceSkillBody, {}, "name is required"],
];

describe("#806 batch 3 — rejected bodies keep the guard's exact message", () => {
  for (const [name, schema, body, message] of REJECTS) {
    it(`${name} answers "${message}"`, () => {
      const actual = wireError(schema, body);
      // The drive-obstacle enum message ends in a generated list of the valid kinds.
      if (message.endsWith(": ")) expect(actual?.startsWith(message)).toBe(true);
      else expect(actual).toBe(message);
    });
  }

  it("never reports one of zod's own defaults", () => {
    for (const [name, schema, body] of REJECTS) {
      const actual = wireError(schema, body) ?? "";
      expect(actual, name).not.toMatch(/^(Required|Invalid input|Expected )/);
    }
  });
});

describe("#806 batch 3 — bodies that succeed today still succeed", () => {
  const ACCEPTS: Array<[string, ZodType<unknown>, unknown]> = [
    // `olderThanDays` is coerced by the handler (`Number(...)`), so the string form is live.
    ["archive-done with a string olderThanDays", archiveDoneBody, { projectId: "p", olderThanDays: "30" }],
    // Fields the create route DECLARED but never checked stay unchecked — tightening them
    // would 400 callers who send the wrong primitive today.
    ["create issue with a numeric estimate", createIssueBody, { projectId: "p", title: "t", estimate: 5 }],
    ["create issue with a string sortOrder", createIssueBody, { projectId: "p", title: "t", sortOrder: "3" }],
    ["create issue with a non-array reposTouched", createIssueBody, { projectId: "p", title: "t", reposTouched: "web" }],
    ["a boolean refresh", analyzeTouchedFilesBody, { refresh: true }],
    ["an absent refresh", analyzeTouchedFilesBody, {}],
    // The handler whitelists `kind`/`author` and FALLS BACK rather than rejecting.
    ["a comment with an unknown kind", issueCommentBody, { body: "hi", kind: "bogus", author: "martian" }],
    // `parseTestOutput` treats anything but "playwright" as vitest.
    ["an unknown runner", flakyParseBody, { sessionId: "s", output: "{}", runner: "junit" }],
    // Read as truthiness (`if (body.dryRun)`), so a non-boolean is meaningful, not an error.
    ["a truthy non-boolean dryRun", mergeQueueBody, { workspaceIds: ["w"], dryRun: "yes" }],
    // `severity` is optional; its predicate must short-circuit on `undefined`.
    ["a drive obstacle with no severity", driveObstacleBody, { kind: "stall", summary: "s" }],
    // Element shapes are deliberately unvalidated — `Array.isArray` and nothing more.
    ["answers whose elements are empty objects", answerAgentQuestionBody, { workspaceId: "w", questions: [{}], answers: [{}] }],
    ["an empty artifact caption", issueArtifactBody, { type: "image", content: "x", caption: "" }],
  ];

  for (const [name, schema, body] of ACCEPTS) {
    it(`accepts ${name}`, () => {
      expect(wireError(schema, body)).toBeNull();
    });
  }

  it("the drive-obstacle kind predicate accepts every declared kind", () => {
    // Guards against the enum message drifting from the constant it is generated from.
    const message = wireError(driveObstacleBody, { kind: "definitely-not-a-kind", summary: "s" }) ?? "";
    const declared = message.replace("kind must be one of: ", "").split(", ");
    expect(declared.length).toBeGreaterThan(0);
    for (const kind of declared) {
      expect(wireError(driveObstacleBody, { kind, summary: "s" }), kind).toBeNull();
    }
  });
});

describe("#806 batch 3 — the value handed to the service is unchanged", () => {
  it("trims transcript and summary, because their handlers did", () => {
    // `createVoiceCaptureIssue` received `body.transcript.trim()`; `requiredTrimmed` is what
    // keeps that true now that the `.trim()` call at the call site is gone.
    expect(voiceCaptureBody.parse({ transcript: "  hello  " }).transcript).toBe("hello");
    expect(driveObstacleBody.parse({ kind: "stall", summary: "  s  " }).summary).toBe("s");
  });

  it("does NOT trim the fields whose handlers passed the original on", () => {
    expect(createIssueBody.parse({ projectId: "p", title: "  padded  " }).title).toBe("  padded  ");
    expect(issueCommentBody.parse({ body: "  padded  " }).body).toBe("  padded  ");
    expect(failurePatternBody.parse({ title: "  padded  " }).title).toBe("  padded  ");
  });

  it("passes unknown keys THROUGH, so a handler forwarding the whole body loses nothing", () => {
    // The class of bug a bare `z.object()` introduces: `addArtifact(issueId, body)` would start
    // receiving fewer fields than it does today, invisibly at the call site.
    const parsed = issueArtifactBody.parse({ type: "image", content: "x", futureField: 1 }) as Record<string, unknown>;
    expect(parsed.futureField).toBe(1);
    const obstacle = driveObstacleBody.parse({ kind: "stall", summary: "s", extra: "keep" }) as Record<string, unknown>;
    expect(obstacle.extra).toBe("keep");
  });
});
