// @gate:always-run — scans services/ and repositories/ for error-class declarations;
// imports only the vocabulary it checks against.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";
import { DOMAIN_ERROR_CODES } from "../errors/index.js";

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
 * Refusal vocabularies that are NOT HTTP-status codes and must not be judged as if they
 * were. `WorkspaceError` carries these and the middleware handles it in its own `instanceof`
 * branch, choosing the status from the reason rather than from a code table.
 */
const NON_HTTP_CODES = new Set([
  "STALE_SAFETY_POLICY",
  "PROFILE_ALLOWLIST_HOLD",
  "NO_AVAILABLE_WORKER",
  "ISOLATION_REFUSED",
  "OPEN_DIRECT_WORKSPACE",
  "UNSAFE_CODEX_MODEL",
  "GROUP_MEMBER_HAS_WORKSPACE",
  "GROUP_MEMBER_IN_LIVE_GROUP",
  "GROUP_MEMBER_WRONG_PROJECT",
]);

/** `readonly code: "A" | "B"` — a hand-written union in an error class. */
const CODE_UNION = /readonly code[?]?:\s*((?:"[A-Z_]+"\s*\|\s*)*"[A-Z_]+")/g;

const files = SCAN_DIRS.flatMap((d) => walkPackageSources(path.join(serverSrc, d)));
const rel = (f: string) => path.relative(serverSrc, f).split(path.sep).join("/");

interface Union { file: string; codes: string[]; raw: string }

function codeUnions(): Union[] {
  const out: Union[] = [];
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(CODE_UNION)) {
      const codes = [...m[1].matchAll(/"([A-Z_]+)"/g)].map((c) => c[1]);
      out.push({ file: rel(file), codes, raw: m[1].replace(/\s+/g, " ") });
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
});
