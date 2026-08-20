// @gate:always-run — scans services/ and repositories/ for error-class declarations;
// imports only the vocabulary it checks against.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";
import { DOMAIN_ERROR_CODES, STANDALONE_REFUSAL_STATUS, WORKSPACE_REFUSAL_CODES } from "../errors/index.js";

/**
 * ONE domain error-code vocabulary (#587).
 *
 * Fifteen service-local error classes each re-spelled their own subset of the same codes —
 * six distinct unions of `NOT_FOUND | BAD_REQUEST | CONFLICT | FORBIDDEN | INVALID_DATA |
 * INTERNAL`. Same shape as #614's nine spellings of `now`: one concept, N spellings.
 *
 * What makes it a BUG rather than untidiness is the mapping. `error-handler.ts` turns a
 * `code` into an HTTP status structurally, and anything it does not recognise falls through
 * to 500 — so a code invented in a service, or simply mistyped, silently becomes an
 * internal-server-error instead of the 404 or 409 it meant. Nothing caught that.
 */
const serverSrc = path.join(import.meta.dirname!, "..");
const SCAN_DIRS = ["services", "repositories", "startup"];

/**
 * Refusal vocabularies that are NOT HTTP-status codes and must not be judged as if they were.
 *
 * #692: this used to be a hand-written copy of the list, exempted on the strength of a comment
 * claiming "the middleware handles it in its own `instanceof` branch". That claim was false for
 * eight of the nine — the branch handled only `STALE_SAFETY_POLICY` — so the exemption was
 * protecting codes that really did fall through to a 500 or lost their reason entirely. The set
 * is now DERIVED from the production declarations the middleware itself reads, and the
 * `is actually handled` test below checks the claim rather than restating it.
 */
const NON_HTTP_CODES = new Set<string>([
  ...WORKSPACE_REFUSAL_CODES,
  ...Object.keys(STANDALONE_REFUSAL_STATUS),
]);

/** `readonly code: "A" | "B"` — a hand-written union in an error class. */
const CODE_UNION = /readonly code[?]?:\s*((?:"[A-Z_]+"\s*\|\s*)*"[A-Z_]+")/g;

/**
 * `readonly code = "A"` — a field INITIALIZER rather than a type annotation (#692).
 *
 * The union regex above cannot match this shape, and `WorkerDispatchUnavailableError`
 * (`agent-dispatch.service.ts`) uses it: its `NO_AVAILABLE_WORKER` was therefore invisible to
 * every assertion in this file while being absent from every status table — the precise defect
 * this suite exists to catch, sitting inside the suite's own blind spot.
 */
const CODE_LITERAL = /readonly code[?]?\s*=\s*"([A-Z_]+)"/g;

const files = SCAN_DIRS.flatMap((d) => walkPackageSources(path.join(serverSrc, d)));
const rel = (f: string) => path.relative(serverSrc, f).split(path.sep).join("/");

interface Union { file: string; codes: string[]; raw: string; initializer?: boolean }

function codeUnions(): Union[] {
  const out: Union[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(CODE_UNION)) {
      const codes = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((c) => c[1]);
      out.push({ file: rel(file), codes, raw: m[1].replace(/\s+/g, " ") });
    }
    // Field initializers are collected separately and marked with `initializer: true`, so the
    // "distinct re-spelled unions" baseline below keeps counting only real unions — a
    // single-code initializer is not a spelling of the shared union and must not inflate it.
    for (const m of src.matchAll(CODE_LITERAL)) {
      out.push({ file: rel(file), codes: [m[1]], raw: `= "${m[1]}"`, initializer: true });
    }
  }
  return out;
}

describe("domain error-code vocabulary (#587)", () => {
  it("the scan finds the error classes at all", () => {
    // A path typo would make every assertion below vacuously green.
    expect(codeUnions().length).toBeGreaterThan(5);
  });

  it("every declared code is either in DOMAIN_ERROR_CODES or a known non-HTTP refusal code", () => {
    // The assertion that catches the real defect: an unrecognised code is a silent 500.
    const known = new Set<string>([...DOMAIN_ERROR_CODES, ...NON_HTTP_CODES]);
    const strays: string[] = [];
    for (const u of codeUnions()) {
      for (const code of u.codes) {
        if (!known.has(code)) strays.push(`${u.file}: "${code}"`);
      }
    }
    expect(
      strays,
      "an unmapped code falls through error-handler.ts to a 500. Add it to " +
        "DOMAIN_ERROR_CODES (with a status) or, if it is a WorkspaceError refusal reason, to " +
        "NON_HTTP_CODES:\n" + strays.join("\n"),
    ).toEqual([]);
  });

  /**
   * Distinct hand-written spellings of the shared vocabulary. **Only ever lower this.**
   * Each is a place the union can drift from `DomainErrorCode`; the fix for any one of them
   * is `readonly code: DomainErrorCode`.
   */
  const SPELLING_BASELINE = 6;

  it("the number of distinct re-spelled unions only shrinks", () => {
    const spellings = new Set(
      codeUnions()
        .filter((u) => !u.initializer)
        .filter((u) => u.codes.every((c) => (DOMAIN_ERROR_CODES as readonly string[]).includes(c)))
        .map((u) => u.raw),
    );
    expect(
      spellings.size,
      `use \`readonly code: DomainErrorCode\` instead of re-spelling the union:\n${[...spellings].join("\n")}`,
    ).toBeLessThanOrEqual(SPELLING_BASELINE);
  });

  it("the baseline is not stale — lower it when the count drops", () => {
    const spellings = new Set(
      codeUnions()
        .filter((u) => !u.initializer)
        .filter((u) => u.codes.every((c) => (DOMAIN_ERROR_CODES as readonly string[]).includes(c)))
        .map((u) => u.raw),
    );
    expect(spellings.size).toBe(SPELLING_BASELINE);
  });

  it("every DOMAIN_ERROR_CODE has an HTTP status (the union and the map are one thing)", async () => {
    // `DOMAIN_CODE_STATUS` is typed `Record<DomainErrorCode, StatusCode>`, so this is
    // compile-enforced — asserted at runtime because a widened union with a missing status
    // is exactly the drift that produces a surprise 500.
    const src = fs.readFileSync(path.join(serverSrc, "middleware", "error-handler.ts"), "utf8");
    // `String.raw` is load-bearing: in a plain template literal `\b` is the BACKSPACE
    // escape, not a regex word boundary, so the pattern silently matched nothing and every
    // code looked unmapped. Found by running it.
    const missing = DOMAIN_ERROR_CODES.filter(
      (c) => !new RegExp(String.raw`\b${c}:\s*\d{3}`).test(src),
    );
    expect(missing, `no HTTP status mapped for: ${missing.join(", ")}`).toEqual([]);
  });

  // #692 — the detector's blind spot, asserted directly: a field-initializer code must be
  // found by the scan, or every assertion above is vacuous for the class that uses one.
  it("finds a code declared as a field initializer, not only as a type annotation", () => {
    const found = codeUnions().filter((u) => u.initializer);
    expect(found.length, "the CODE_LITERAL detector matched nothing — has the shape changed?")
      .toBeGreaterThan(0);
    expect(found.flatMap((u) => u.codes)).toContain("NO_AVAILABLE_WORKER");
  });

  // The claim the old NON_HTTP_CODES exemption rested on, turned into a check. Exempting a
  // code from the HTTP vocabulary is only legitimate if the middleware really does handle it;
  // otherwise the exemption is what hides the silent 500.
  it("every exempt refusal code is actually handled by the middleware", () => {
    const src = fs.readFileSync(path.join(serverSrc, "middleware", "error-handler.ts"), "utf8");
    const unhandled = [...NON_HTTP_CODES].filter((code) => {
      // Handled either by naming the code outright (the bespoke STALE_SAFETY_POLICY branch)
      // or by being a member of a vocabulary the middleware imports and tests against.
      if (src.includes(`"${code}"`)) return false;
      if (src.includes("WORKSPACE_REFUSAL_CODES") && (WORKSPACE_REFUSAL_CODES as readonly string[]).includes(code)) return false;
      if (src.includes("STANDALONE_REFUSAL_STATUS") && code in STANDALONE_REFUSAL_STATUS) return false;
      return true;
    });
    expect(
      unhandled,
      "these codes are exempt from the HTTP vocabulary but nothing in error-handler.ts acts " +
        "on them, so they fall through to a 500 — the exemption is hiding the defect:\n" + unhandled.join("\n"),
    ).toEqual([]);
  });

  it("every standalone refusal code has a status, and it is not the generic 500", () => {
    for (const [code, status] of Object.entries(STANDALONE_REFUSAL_STATUS)) {
      expect(typeof status, `${code} has no numeric status`).toBe("number");
      expect(status, `${code} mapped to 500 is indistinguishable from the fallthrough it fixes`)
        .not.toBe(500);
    }
  });
});
