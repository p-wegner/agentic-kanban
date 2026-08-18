/**
 * #550 — one tolerant extractor replacing six algorithms across thirteen sites.
 *
 * The cases below are the actual failure modes that were live in the codebase, not invented
 * ones: prose-prefixed Haiku output (which four fence-only sites threw on, in the same file
 * whose own doc-comment described the problem), a reply containing two objects (#355's greedy
 * regex spanned both), and banner-prefixed planner stdout (only `parsePluginLoopPlan` handled it).
 */
import { describe, it, expect } from "vitest";
import { extractModelJson, ModelJsonError } from "../src/lib/model-json.js";

describe("extractModelJson (#550)", () => {
  it("parses a bare JSON object — the happy path the fence-only sites already handled", () => {
    expect(extractModelJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("survives conversational prose around the value — the measured Haiku failure", () => {
    // `extractJsonObject`'s doc-comment: the model "frequently prefixes/suffixes the JSON with
    // conversational text". Four sites stripped fences only and threw on exactly this.
    const text = 'Perfect! Here\'s the answer:\n```json\n{"estimate":"M","reasoning":"two files"}\n```\nLet me know if you need more.';
    expect(extractModelJson(text, { shape: "object" })).toEqual({ estimate: "M", reasoning: "two files" });
  });

  it("takes the FIRST balanced object when a reply contains two — #355's greedy-match bug", () => {
    // `/\{[\s\S]*\}/` spanned both objects and threw, and the throw was recorded in the least
    // actionable bucket rather than as a malformed reply.
    expect(extractModelJson('{"actionId":"approve"} and also {"actionId":"revise"}', { shape: "object" }))
      .toEqual({ actionId: "approve" });
  });

  it("takes the LAST value with prefer:last — banner-prefixed planner stdout", () => {
    const stdout = 'npm notice New minor version available\n{"units":[],"converged":false}';
    expect(extractModelJson(stdout, { prefer: "last" })).toEqual({ units: [], converged: false });
  });

  it("does not let a nested value outrank its parent under prefer:last", () => {
    // The scan skips past a value it accepted; otherwise the innermost object would win.
    expect(extractModelJson('{"outer":{"inner":1}}', { prefer: "last" })).toEqual({ outer: { inner: 1 } });
  });

  it("ignores braces and brackets INSIDE strings", () => {
    // The old first-`{`-to-last-`}` slice could not see this; a balanced scan must track strings.
    expect(extractModelJson('{"note":"use } and { carefully","ok":true}'))
      .toEqual({ note: "use } and { carefully", ok: true });
    // An escaped quote must not end the string early, or the `}` after it would close the object.
    expect(extractModelJson(String.raw`{"note":"he said \"stop}\" loudly","n":1}`)).toEqual({ note: 'he said "stop}" loudly', n: 1 });
  });

  it("honours the requested shape rather than taking whatever comes first", () => {
    const text = 'Options: ["a","b"]\nAnswer: {"pick":"a"}';
    expect(extractModelJson(text, { shape: "object" })).toEqual({ pick: "a" });
    expect(extractModelJson(text, { shape: "array" })).toEqual(["a", "b"]);
    expect(extractModelJson(text)).toEqual(["a", "b"]);
  });

  it("skips balanced-but-unparseable candidates instead of giving up at the first one", () => {
    // Prose in braces, then the real value. A first-match-wins slice would have thrown here.
    const text = 'The model said {not json at all} then printed {"ok":true}';
    expect(extractModelJson(text, { shape: "object" })).toEqual({ ok: true });
  });

  it("accepts a bare array, which the loop planner is allowed to print", () => {
    expect(extractModelJson('[{"id":"u1"}]')).toEqual([{ id: "u1" }]);
  });

  it("throws ModelJsonError carrying the output tail, so callers can report what was said", () => {
    const noise = "x".repeat(500) + " no json here";
    let err: unknown;
    try { extractModelJson(noise, { shape: "object" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ModelJsonError);
    expect((err as ModelJsonError).tail).toHaveLength(400);
    expect((err as ModelJsonError).tail.endsWith("no json here")).toBe(true);
  });

  it("throws on empty or whitespace-only output", () => {
    expect(() => extractModelJson("")).toThrow(ModelJsonError);
    expect(() => extractModelJson("   \n ")).toThrow(ModelJsonError);
  });

  it("throws when the value never closes — a truncated reply is not a partial answer", () => {
    expect(() => extractModelJson('{"a":1', { shape: "object" })).toThrow(ModelJsonError);
  });
});
