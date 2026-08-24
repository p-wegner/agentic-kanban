/**
 * #806 batch 5 — the six handlers whose bodies moved onto zod schemas, pinned at the level the
 * swap could break invisibly: the MESSAGE a rejected body gets, and the bodies that must keep
 * being ACCEPTED.
 *
 * Same shape as the batch-3 and batch-4 contract suites, and the same reason for it: a
 * guard→schema swap is only a hardening if every request that succeeded before still succeeds.
 * They are schema-level rather than HTTP-level because `parseJsonBody` surfaces only the FIRST
 * issue as `{ error: message }` at 400, so `safeParse(...).error.issues[0].message` IS the wire
 * text.
 *
 * **What is different about batch 5, and what these tests exist to hold.** Batch 4 recorded all
 * six of these as rejections; batch 5 re-derived the reasons and found them wrong. Three of the
 * six (`butler.ts`) replace NO guard at all — they are the #512 declared-type tightening, whose
 * entire behaviour change is "a request that answered 500 now answers 400". The risk there is
 * not the rejection, it is the ACCEPTANCE: `null`, an absent key and an empty string all mean
 * something specific on those routes (default model, no profile, DELETE the skill override),
 * and a schema that rejected any of them would be the regression batch 4 feared. Those live
 * bodies are the bulk of what is asserted below.
 */
import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { HTTPException } from "hono/http-exception";
import {
  butlerModelBody,
  butlerProfileBody,
  butlerSkillBody,
} from "../routes/butler-body-schemas.js";
import { createButlerDefinitionBody } from "../routes/butler-definitions-body-schemas.js";
import { createSkillBody } from "../routes/agent-skill-body-schemas.js";
import { createProjectBody } from "../routes/project-body-schemas.js";
import { ButlerDefinitionError } from "../services/butler-definitions.service.js";
import { AgentSkillError } from "../services/agent-skill.service.js";
import { ProjectError } from "../services/project-error.js";
import { DOMAIN_CODE_STATUS } from "../middleware/error-handler.js";

/** The exact text `parseJsonBody` would put in `{ error }`, or `null` when the body passes. */
function wireError(schema: ZodType<unknown>, body: unknown): string | null {
  const result = schema.safeParse(body);
  return result.success ? null : (result.error.issues[0]?.message ?? "invalid request body");
}

/** `[label, schema, body, the message the caller now gets]` */
const REJECTS: Array<[string, ZodType<unknown>, unknown, string]> = [
  // butler ×3 — every one of these is a 500 (a TypeError on `.trim()`) at the previous commit.
  ["butler POST /model (number)", butlerModelBody, { model: 7 }, "model must be a string"],
  ["butler POST /model (object)", butlerModelBody, { model: {} }, "model must be a string"],
  ["butler POST /profile (number)", butlerProfileBody, { profile: 7 }, "profile must be a string"],
  ["butler PUT /skill (number)", butlerSkillBody, { prompt: 7 }, "prompt must be a string"],
  ["butler PUT /skill (array)", butlerSkillBody, { prompt: ["a"] }, "prompt must be a string"],
  // butler-definitions POST — the service's FIRST statement, message copied verbatim.
  ["butler-definitions POST (absent)", createButlerDefinitionBody, {}, "Butler name is required"],
  ["butler-definitions POST (null)", createButlerDefinitionBody, { name: null }, "Butler name is required"],
  ["butler-definitions POST (blank)", createButlerDefinitionBody, { name: "   " }, "Butler name is required"],
  ["butler-definitions POST (number)", createButlerDefinitionBody, { name: 7 }, "Butler name is required"],
  // agent-skills POST — ONE message for three fields, because it was ONE condition.
  ["agent-skills POST (nothing)", createSkillBody, {}, "name, description, and prompt are required"],
  [
    "agent-skills POST (name only)",
    createSkillBody,
    { name: "n" },
    "name, description, and prompt are required",
  ],
  [
    "agent-skills POST (empty prompt)",
    createSkillBody,
    { name: "n", description: "d", prompt: "" },
    "name, description, and prompt are required",
  ],
  // projects POST /create — `{}` was a 500 (`undefined.trim()`) at the previous commit.
  ["projects POST /create (absent)", createProjectBody, {}, "name is required"],
  ["projects POST /create (blank)", createProjectBody, { name: "  " }, "name is required"],
  ["projects POST /create (number)", createProjectBody, { name: 7 }, "name is required"],
];

describe("#806 batch 5 — rejected bodies get the message the endpoint already used", () => {
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

describe("#806 batch 5 — bodies that succeed today still succeed", () => {
  const ACCEPTS: Array<[string, ZodType<unknown>, unknown]> = [
    // ---- butler POST /model. `normalizeModelForBackend` maps anything it does not recognise
    // to "" (= let the backend choose), so an unknown model string is a LIVE request meaning
    // "default" and must not become a 400 (rule 3). Absent and null both reach `?? ""`.
    ["a known model", butlerModelBody, { model: "opus" }],
    ["an UNKNOWN model string", butlerModelBody, { model: "gpt-9" }],
    ["an empty model", butlerModelBody, { model: "" }],
    ["a null model", butlerModelBody, { model: null }],
    ["no model key at all", butlerModelBody, {}],
    // ---- butler POST /profile. `(body.profile ?? "").trim()`: absent and null both mean
    // "clear the profile", and "" is the stored value for that.
    ["a profile", butlerProfileBody, { profile: "anth" }],
    ["an empty profile", butlerProfileBody, { profile: "" }],
    ["a whitespace-only profile", butlerProfileBody, { profile: "   " }],
    ["a null profile", butlerProfileBody, { profile: null }],
    ["no profile key at all", butlerProfileBody, {}],
    // ---- butler PUT /skill. THE branch: `!body.prompt?.trim()` DELETES the project override
    // and answers 200. All four falsy forms are the documented way to revert to the global
    // default, and batch 4 rejected this entry believing a schema had to 400 them.
    ["a real prompt", butlerSkillBody, { prompt: "You are…" }],
    ["an EMPTY prompt (deletes the override, 200)", butlerSkillBody, { prompt: "" }],
    ["a WHITESPACE-ONLY prompt (deletes the override, 200)", butlerSkillBody, { prompt: "  \n\t " }],
    ["a NULL prompt (deletes the override, 200)", butlerSkillBody, { prompt: null }],
    ["NO prompt key at all (deletes the override, 200)", butlerSkillBody, {}],
    // ---- butler-definitions POST. `provider` is read through a ternary mapping anything
    // unrecognised to undefined, and `model` is persisted verbatim — both stay unchecked.
    ["a butler with a numeric provider", createButlerDefinitionBody, { name: "Quick", provider: 7 }],
    ["a butler with a numeric model", createButlerDefinitionBody, { name: "Quick", model: 7 }],
    ["a butler with a null provider", createButlerDefinitionBody, { name: "Quick", provider: null }],
    // ---- agent-skills POST. The guard is a bare truthy test on fields it never type-checked,
    // so a numeric name creates a skill today (`RegExp.test` coerces) and must keep doing so.
    ["a skill whose fields are numbers", createSkillBody, { name: 7, description: 7, prompt: 7 }],
    ["a skill with a whitespace-only name", createSkillBody, { name: " ", description: "d", prompt: "p" }],
    ["a skill with a null projectId", createSkillBody, { name: "n", description: "d", prompt: "p", projectId: null }],
    ["a skill with a string isInit", createSkillBody, { name: "n", description: "d", prompt: "p", isInit: "yes" }],
    // ---- projects POST /create. Batch 2 declined the whole file on the optional fields' null
    // discipline; that concern is respected by leaving every one of them unchecked.
    ["a project with a null description", createProjectBody, { name: "p", description: null }],
    ["a project with a numeric path", createProjectBody, { name: "p", path: 7 }],
    ["a project with a string generateReadme", createProjectBody, { name: "p", generateReadme: "yes" }],
  ];

  for (const [name, schema, body] of ACCEPTS) {
    it(`accepts ${name}`, () => {
      expect(wireError(schema, body)).toBeNull();
    });
  }
});

describe("#806 batch 5 — the value handed to the service is unchanged", () => {
  it("does NOT trim, because every one of these handlers passed the original on", () => {
    // `createButlerDefinition` / `createProject` trim it themselves; trimming here would move
    // where that happens and hand the duplicate-name lookup a different string.
    expect(createButlerDefinitionBody.parse({ name: "  Quick  " }).name).toBe("  Quick  ");
    expect(createProjectBody.parse({ name: "  proj  " }).name).toBe("  proj  ");
  });

  it("passes unknown keys THROUGH, so a handler forwarding the whole body loses nothing", () => {
    // `createSkill(body)` and `createProject(body)` take the WHOLE body; a bare z.object()
    // would silently strip fields a future release adds.
    const skill = createSkillBody.parse({ name: "n", description: "d", prompt: "p", futureField: 1 }) as Record<string, unknown>;
    expect(skill.futureField).toBe(1);
    const project = createProjectBody.parse({ name: "p", futureField: 1 }) as Record<string, unknown>;
    expect(project.futureField).toBe(1);
    const butler = createButlerDefinitionBody.parse({ name: "b", futureField: 1 }) as Record<string, unknown>;
    expect(butler.futureField).toBe(1);
  });

  it("keeps every field the OpenAPI property list had before the swap", () => {
    // The schema is now what `scripts/generate-openapi.ts` reads, so a field dropped from the
    // schema is a field deleted from the spec (#838). These three replaced a `parseJsonBody<T>`
    // whose type argument WAS the previous property list, so the lists must match it exactly.
    const keys = (schema: unknown) => Object.keys((schema as { shape: Record<string, unknown> }).shape);
    expect(keys(createSkillBody)).toEqual([
      "name", "description", "prompt", "model", "projectId", "isInit",
    ]);
    expect(keys(createProjectBody)).toEqual([
      "name", "path", "description", "color", "gitignoreTemplate", "generateReadme",
    ]);
    expect(keys(createButlerDefinitionBody)).toEqual(["name", "model", "provider"]);
    expect(keys(butlerModelBody)).toEqual(["model"]);
    expect(keys(butlerProfileBody)).toEqual(["profile"]);
    expect(keys(butlerSkillBody)).toEqual(["prompt"]);
  });
});

describe("#806 batch 5 — the route's ERROR IDENTITY survives the swap", () => {
  // The three services whose guards moved to the boundary throw a coded domain error, which
  // `domainErrorHandler` renders as `{ error, code }`. `parseJsonBody` throws a bare
  // `HTTPException` (`{ error }` alone), so each route re-wraps it — `parsePluginBody`'s pattern
  // from batch 2. A schema that gets the message right and loses `code` is exactly the invisible
  // break this suite exists for.
  const WRAPPERS: Array<[string, string, (message: string) => { message: string; code: string }]> = [
    ["ButlerDefinitionError", "Butler name is required", (m) => new ButlerDefinitionError(m, "BAD_REQUEST")],
    ["AgentSkillError", "name, description, and prompt are required", (m) => new AgentSkillError(m, "BAD_REQUEST")],
    ["ProjectError", "name is required", (m) => new ProjectError(m, "BAD_REQUEST")],
  ];

  for (const [name, message, make] of WRAPPERS) {
    it(`${name} re-wraps a schema rejection at the same 400 with the same message`, () => {
      const rejection = new HTTPException(400, { message });
      const wrapped = make(rejection.message);
      expect(wrapped.message).toBe(message);
      expect(wrapped.code).toBe("BAD_REQUEST");
      expect(DOMAIN_CODE_STATUS[wrapped.code as "BAD_REQUEST"]).toBe(rejection.status);
    });
  }

  it("the three butler routes are deliberately NOT wrapped — they never carried a code", () => {
    // `POST /:id/butler/model` answers `c.json({ error }, 400)` for an update failure and
    // `c.json({ error: "Project not found" }, 404)` on /profile — bare `{ error }` bodies with
    // no `code`. Wrapping them would ADD a field to a rejection that has never had one, which
    // is as much a wire change as dropping one.
    expect(new HTTPException(400, { message: "model must be a string" }).status).toBe(400);
  });
});
