// @gate:always-run — recursively walks the whole client source tree and parses every file; it
// imports nothing it measures, so `vitest related` can never select it from a component diff.
import { describe, expect, it } from "vitest";
import path from "node:path";
import ts from "typescript";
import {
  walkPackageSources,
  parseGuardSource,
  forEachNode,
  calleeName,
  compareRatchet,
  lineOf,
} from "../../../shared/__tests__/helpers/guard-scan.js";
import { API_RESPONSE_SCHEMAS, findApiResponseSchema } from "../lib/apiResponseSchemas.js";
import { DYNAMIC_API_CALL_SITES, UNVALIDATED_API_RESPONSES } from "./api-response-validation-baseline.js";

/**
 * #806, OUTBOUND half — **responses the client parses but never CHECKS, shrink-only.**
 *
 * Why this file exists at all
 * ---------------------------
 * #780 built the seam (`apiFetch` validates against a method+path registry, everything else
 * goes through the named `unvalidatedResponse`) and registered 17 endpoints. Then nothing
 * moved: five #806 batches landed on the INBOUND half while the registry stayed at exactly
 * the 17 entries #780 left it at, with one commit ever touching that file. The inbound half
 * moved every batch because `route-body-validation-ratchet.test.ts` made stagnation go red.
 * The outbound half had no such gate, so stagnation was invisible. This is that gate.
 *
 * What it measures
 * ----------------
 * The set of `METHOD /path/template` pairs the CLIENT ACTUALLY CALLS, DERIVED from the AST of
 * every client source file rather than restated as a hand-written list. That distinction is
 * the whole design: a hand-list is what let `fixture-temp-dir-sweep.test.ts` stay green for
 * months while measuring the wrong thing, and any list of endpoints goes stale the first time
 * someone adds a panel. Every `apiFetch` / `apiFetchConditional` / `apiPost` / `apiPut` /
 * `apiPatch` / `apiDelete` call is read: the first argument gives the path (a string literal,
 * a template literal whose `${...}` segments become `:param`, or a `+` concatenation of
 * those), and the callee name or a literal `method:` gives the verb.
 *
 * Deriving the CLIENT's surface — not the server's — is deliberate. #806 quotes "275 of 292
 * paths", which counts the generated OpenAPI spec: it includes endpoints only the MCP server,
 * the CLI or a fleet worker calls, and no entry in this registry can ever cover those, because
 * the registry only runs inside `apiFetch`. The number that can actually reach zero is the one
 * below.
 *
 * Three assertions, each because its absence has bitten this repo
 * --------------------------------------------------------------
 *  1. **The scan is not a no-op.** A guard that silently stops finding anything passes
 *     forever; `countAlwaysRunGuardSuites` under-reported for months exactly that way. The
 *     file count, the call count, the pair count and the number of COVERED pairs are all
 *     pinned above a floor — and the covered floor is the sharp one, because it goes to zero
 *     the moment the path normaliser stops agreeing with `findApiResponseSchema`, which is the
 *     realistic way this scanner breaks.
 *  2. **No new unvalidated endpoint.** A pair the client calls with no registered schema and
 *     no baseline line fails. Registering a schema is the fix; adding a line WITH a written
 *     reason is the sanctioned alternative for a response that cannot be schematised.
 *  3. **No stale baseline line.** A line whose endpoint is now registered — or no longer
 *     called at all — fails, so entries are DELETED when fixed rather than zeroed. Without
 *     this half a ceiling decays into a budget and the next regression hides in the slack.
 */
const CLIENT_SRC = path.join(import.meta.dirname!, "..");

/**
 * `lib/api.ts` IS the seam. The `apiFetch(path, …)` calls inside `apiPost`/`apiPut`/… are the
 * helper bodies, not call sites, and their path is a parameter by construction.
 */
const SEAM_MODULE = "lib/api.ts";

/** Callee name → the verb it always sends. `apiFetch` itself reads its `init.method`. */
const VERB_HELPERS = new Map<string, string>([
  ["apiPost", "POST"],
  ["apiPut", "PUT"],
  ["apiPatch", "PATCH"],
  ["apiDelete", "DELETE"],
]);

/** Stands in for an interpolated `${…}` while the path is still one flat string. */
const DYN = "\u0000";

/** The path as a flat string with `${…}` collapsed to {@link DYN}, or `null` if not literal. */
function literalPath(expr: ts.Node): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr)) return literalPath(expr.expression);
  if (ts.isTemplateExpression(expr)) {
    let out = expr.head.text;
    for (const span of expr.templateSpans) out += DYN + span.literal.text;
    return out;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalPath(expr.left);
    const right = literalPath(expr.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/**
 * `/api/projects/${id}/stats` → `/api/projects/:param/stats`.
 *
 * A segment that MIXES literal text with an interpolation (`/api/plugins${query}`) is refused
 * rather than guessed at, because guessing costs real accuracy in both directions: read as a
 * path parameter, `/api/workspaces/cleanup-warnings${qs}` becomes `/api/workspaces/:param` and
 * helps itself to the coverage of the registered `GET /api/workspaces/:id`; read as a query
 * string, `/api/projects/${id}/butler${path}` silently loses a whole path suffix. Those sites
 * are counted in {@link DYNAMIC_API_CALL_SITES} instead.
 */
function templateOf(raw: string): string | null {
  const withoutQuery = raw.split(/[?#]/)[0] ?? raw;
  if (!withoutQuery.startsWith("/api/")) return null;
  const segments: string[] = [];
  for (const segment of withoutQuery.split("/").filter(Boolean)) {
    if (!segment.includes(DYN)) segments.push(segment);
    else if (segment === DYN) segments.push(":param");
    else return null;
  }
  return `/${segments.join("/")}`;
}

/** The verb of an `apiFetch(path, init)` call: `GET` by default, `null` when not readable. */
function methodOf(init: ts.Expression | undefined): string | null {
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return null;
  let spread = false;
  for (const property of init.properties) {
    if (ts.isSpreadAssignment(property)) spread = true;
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== "method") continue;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.toUpperCase();
    return null;
  }
  // A spread could carry a `method` this scan cannot see; without one, the default is GET.
  return spread ? null : "GET";
}

interface Scan {
  files: number;
  calls: number;
  /** `METHOD /path/:param` → the `file:line` sites that call it. */
  pairs: Map<string, string[]>;
  /** Client-relative file → call sites whose method or path is not statically readable. */
  dynamic: Record<string, number>;
}

function scanClient(): Scan {
  const files = walkPackageSources(CLIENT_SRC).filter(
    (file) => !file.replaceAll("\\", "/").endsWith(`src/${SEAM_MODULE}`),
  );
  const pairs = new Map<string, string[]>();
  const dynamic: Record<string, number> = {};
  let calls = 0;

  for (const file of files) {
    const sf = parseGuardSource(file);
    const rel = path.relative(CLIENT_SRC, file).replaceAll("\\", "/");
    forEachNode(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = calleeName(node);
      if (callee === null) return;
      const isFetch = callee === "apiFetch" || callee === "apiFetchConditional";
      if (!isFetch && !VERB_HELPERS.has(callee)) return;
      calls += 1;

      const first = node.arguments[0];
      const raw = first ? literalPath(first) : null;
      const template = raw === null ? null : templateOf(raw);
      const method =
        VERB_HELPERS.get(callee) ?? (callee === "apiFetchConditional" ? "GET" : methodOf(node.arguments[1]));
      if (template === null || method === null) {
        dynamic[rel] = (dynamic[rel] ?? 0) + 1;
        return;
      }
      const key = `${method} ${template}`;
      const sites = pairs.get(key) ?? [];
      sites.push(`${rel}:${lineOf(sf, node)}`);
      pairs.set(key, sites);
    });
  }
  return { files: files.length, calls, pairs, dynamic };
}

const scan = scanClient();
const covered: string[] = [];
const unvalidated: string[] = [];
for (const key of [...scan.pairs.keys()].sort()) {
  const [method, template] = key.split(" ") as [string, string];
  (findApiResponseSchema(method, template) ? covered : unvalidated).push(key);
}

describe("client response validation is shrink-only (#806, outbound)", () => {
  it("the scan is not a no-op — it sees the tree, the calls, and the registry", () => {
    // Pinned well below today's values (475 files / 445 calls / 257 pairs) so ordinary
    // deletion never trips them, and far above zero so a broken walk or a renamed helper
    // cannot present itself as "nothing left to validate".
    expect(scan.files, "the client source walk found almost nothing").toBeGreaterThan(300);
    expect(scan.calls, "no API call sites found — the callee match has broken").toBeGreaterThan(300);
    expect(scan.pairs.size, "no method+path pairs resolved — the path normaliser has broken").toBeGreaterThan(150);
    // The sharp one. If the normaliser and `findApiResponseSchema` stop agreeing about what a
    // path looks like, EVERY pair reads as unvalidated: a huge fake regression, or — with the
    // baseline regenerated from that broken scan — a guard that silently measures nothing.
    expect(covered.length, "no registered endpoint matched a real call site").toBeGreaterThan(10);
    expect(API_RESPONSE_SCHEMAS.length).toBeGreaterThan(0);
  });

  it("no client endpoint becomes unvalidated without being written down", () => {
    const allowed = new Set(UNVALIDATED_API_RESPONSES);
    const added = unvalidated
      .filter((key) => !allowed.has(key))
      .map((key) => `${key}  (${scan.pairs.get(key)!.join(", ")})`);
    expect(
      added,
      "These endpoints are called by the client and their response is not checked.\n" +
        "Register a schema in `lib/apiResponseSchemas.ts` — derive its shape from the SERVER's\n" +
        "return type, never from a sample response — or, if the response genuinely cannot be\n" +
        "schematised, add the line to `api-response-validation-baseline.ts` WITH a reason:\n" +
        added.join("\n"),
    ).toEqual([]);
  });

  it("no baseline entry is stale — a fixed endpoint's line is deleted, not zeroed", () => {
    const live = new Set(unvalidated);
    const stale = UNVALIDATED_API_RESPONSES.filter((key) => !live.has(key)).map((key) =>
      scan.pairs.has(key)
        ? `${key} — now has a registered schema; delete this line`
        : `${key} — the client no longer calls this; delete this line`,
    );
    expect(stale, `Stale baseline entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it("the scanner's blind spots do not grow", () => {
    const { over, stale } = compareRatchet(DYNAMIC_API_CALL_SITES, scan.dynamic);
    expect(
      over,
      "New call sites whose method or path this guard cannot read. Prefer a literal path and\n" +
        "an object-literal `init` so the endpoint stays visible to the ratchet:\n" +
        over.join("\n"),
    ).toEqual([]);
    expect(stale, `Stale DYNAMIC_API_CALL_SITES entries — lower or delete:\n${stale.join("\n")}`).toEqual([]);
  });
});
