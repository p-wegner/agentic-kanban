/**
 * generate-openapi.ts — static OpenAPI 3.1 spec generator for the Hono REST API.
 *
 * The REST layer uses vanilla Hono (`router.get("/path", handler)`) with no
 * per-route schemas, so there is no runtime metadata to derive a spec from.
 * Instead we statically analyse the route source with ts-morph:
 *
 *   1. Parse `src/routes/index.ts` to map each `create<Name>Route` factory to the
 *      prefix it is mounted under (`routes.route("/projects", createProjectsRoute(...))`),
 *      plus any routes declared inline on the aggregate router.
 *   2. For every `src/routes/*.ts` factory, find the `createRouter()` variable and
 *      walk its `.get/.post/.put/.patch/.delete(...)` calls.
 *   3. Per route, infer: path (+ `:param` -> `{param}`), path params, query params
 *      (from `c.req.query("x")`), request body shape (from the `parseJsonBody<T>(c)`
 *      / `parseOptionalJsonBody<T>(c)` type argument), and response status codes
 *      (from `c.json(body, status)`).
 *
 * Schemas are best-effort: types are read syntactically from the TS type literal,
 * not validated at runtime. Routes the analyser cannot resolve are reported to
 * stderr so coverage gaps are visible rather than silent.
 *
 * Run: `pnpm openapi:generate` (writes packages/server/openapi.yaml).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import {
  Project,
  SyntaxKind,
  Node,
  type CallExpression,
  type TypeNode,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const routesDir = path.join(serverRoot, "src", "routes");
const outputPath = path.join(serverRoot, "openapi.yaml");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** JSON-Schema-ish object we emit into the OpenAPI doc. */
type Schema = Record<string, unknown>;

interface RouteInfo {
  method: HttpMethod;
  /** Full path including `/api` prefix and `{param}` placeholders. */
  path: string;
  sourceFile: string;
  line: number;
  pathParams: string[];
  queryParams: string[];
  requestBody?: Schema;
  /** true when body is parsed without a generic type argument (unknown shape). */
  requestBodyUnknown?: boolean;
  requestBodyOptional?: boolean;
  responseStatuses: number[];
  summary: string;
}

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { allowJs: false },
});

// ---------------------------------------------------------------------------
// Step 1 — mount-prefix map from routes/index.ts
// ---------------------------------------------------------------------------

interface MountInfo {
  prefix: string;
}

/** factory name (e.g. "createProjectsRoute") -> mount prefix (e.g. "/projects"). */
const factoryPrefixes = new Map<string, MountInfo>();
/** inline routes declared directly on the aggregate router in createRoutes. */
const inlineRoutes: RouteInfo[] = [];

function literalString(node: Node | undefined): string | undefined {
  if (node && Node.isStringLiteral(node)) return node.getLiteralValue();
  return undefined;
}

function loadIndexMounts() {
  const indexPath = path.join(routesDir, "index.ts");
  const sf = project.addSourceFileAtPath(indexPath);
  const aggregateRouterName = findCreateRouterVar(sf);

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const obj = expr.getExpression().getText();
    const member = expr.getName();

    // routes.route("/prefix", createXxxRoute(...))
    if (member === "route") {
      const args = call.getArguments();
      const prefix = literalString(args[0]);
      const factoryArg = args[1];
      if (prefix === undefined || !factoryArg || !Node.isCallExpression(factoryArg)) continue;
      const factoryName = factoryArg.getExpression().getText();
      factoryPrefixes.set(factoryName, { prefix });
      continue;
    }

    // routes.post("/internal/...", handler) — inline routes on the aggregate router
    if (obj === aggregateRouterName && (HTTP_METHODS as readonly string[]).includes(member)) {
      const route = parseRouteCall(call, member as HttpMethod, "", sf.getBaseName());
      if (route) inlineRoutes.push(route);
    }
  }
}

/** Find the variable name a `createRouter()` call is assigned to within a node. */
function findCreateRouterVar(scope: Node): string | undefined {
  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init) && init.getExpression().getText() === "createRouter") {
      return decl.getName();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 2/3 — per-route extraction
// ---------------------------------------------------------------------------

function getHandler(call: CallExpression): ArrowFunction | FunctionExpression | undefined {
  const args = call.getArguments();
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i];
    if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) return a;
  }
  return undefined;
}

function parseRouteCall(
  call: CallExpression,
  method: HttpMethod,
  prefix: string,
  sourceFile: string,
): RouteInfo | undefined {
  const args = call.getArguments();
  const subPath = literalString(args[0]);
  if (subPath === undefined) return undefined; // not a string-literal path — skip

  const handler = getHandler(call);
  const rawPath = joinPaths("/api", prefix, subPath);
  const { openapiPath, pathParams } = convertPath(rawPath);

  const info: RouteInfo = {
    method,
    path: openapiPath,
    sourceFile,
    line: call.getStartLineNumber(),
    pathParams,
    queryParams: [],
    responseStatuses: [],
    summary: leadingComment(call) ?? `${method.toUpperCase()} ${openapiPath}`,
  };

  if (handler) analyseHandler(handler, info);
  if (info.responseStatuses.length === 0) info.responseStatuses = [200];
  info.responseStatuses = [...new Set(info.responseStatuses)].sort((a, b) => a - b);
  info.queryParams = [...new Set(info.queryParams)];
  return info;
}

function analyseHandler(handler: Node, info: RouteInfo) {
  for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();

    // parseJsonBody<T>(c) / parseOptionalJsonBody<T>(c)
    const calleeName = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined;
    if (calleeName === "parseJsonBody" || calleeName === "parseOptionalJsonBody") {
      info.requestBodyOptional = calleeName === "parseOptionalJsonBody";
      const typeArg = call.getTypeArguments()[0];
      if (typeArg) {
        info.requestBody = typeNodeToSchema(typeArg);
      } else {
        info.requestBodyUnknown = true;
      }
      continue;
    }

    if (!Node.isPropertyAccessExpression(expr)) continue;
    const member = expr.getName();

    // c.req.query("x")
    if (member === "query") {
      const key = literalString(call.getArguments()[0]);
      if (key) info.queryParams.push(key);
      continue;
    }

    // c.json(body, status)
    if (member === "json") {
      const statusArg = call.getArguments()[1];
      if (statusArg && Node.isNumericLiteral(statusArg)) {
        info.responseStatuses.push(Number(statusArg.getLiteralValue()));
      } else {
        info.responseStatuses.push(200);
      }
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// TypeNode -> JSON Schema (syntactic, best-effort)
// ---------------------------------------------------------------------------

function typeNodeToSchema(node: TypeNode): Schema {
  // Union: strip null/undefined, mark nullable, take first concrete member.
  if (Node.isUnionTypeNode(node)) {
    const members = node.getTypeNodes();
    const nonNull = members.filter((m) => {
      const t = m.getText();
      return t !== "null" && t !== "undefined";
    });
    const nullable = nonNull.length !== members.length;
    const base = nonNull[0] ? typeNodeToSchema(nonNull[0]) : {};
    if (nullable) (base as Schema).nullable = true;
    return base;
  }

  if (Node.isArrayTypeNode(node)) {
    return { type: "array", items: typeNodeToSchema(node.getElementTypeNode()) };
  }

  if (Node.isTypeLiteral(node)) {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const member of node.getMembers()) {
      if (!Node.isPropertySignature(member)) continue;
      const name = member.getName();
      const t = member.getTypeNode();
      properties[name] = t ? typeNodeToSchema(t) : {};
      if (!member.hasQuestionToken()) required.push(name);
    }
    const schema: Schema = { type: "object", properties };
    if (required.length) schema.required = required;
    return schema;
  }

  switch (node.getKind()) {
    case SyntaxKind.StringKeyword:
      return { type: "string" };
    case SyntaxKind.NumberKeyword:
      return { type: "number" };
    case SyntaxKind.BooleanKeyword:
      return { type: "boolean" };
    default: {
      // string-literal-union enums, named types, Record<...>, etc. -> permissive.
      if (Node.isLiteralTypeNode(node)) {
        const lit = node.getLiteral();
        if (Node.isStringLiteral(lit)) return { type: "string", enum: [lit.getLiteralValue()] };
      }
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Path + comment helpers
// ---------------------------------------------------------------------------

function joinPaths(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/");
  return "/" + joined;
}

function convertPath(p: string): { openapiPath: string; pathParams: string[] } {
  const pathParams: string[] = [];
  const openapiPath = p.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    pathParams.push(name);
    return `{${name}}`;
  });
  return { openapiPath, pathParams };
}

/** Single-line `//` comment immediately above the route call, if any. */
function leadingComment(call: CallExpression): string | undefined {
  const stmt = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? call;
  const ranges = stmt.getLeadingCommentRanges();
  if (!ranges.length) return undefined;
  const text = ranges[ranges.length - 1].getText();
  const cleaned = text
    // Normalise line endings FIRST. This repo is deliberately mixed CRLF/LF
    // (.gitattributes pins only the shebang trees), so without this the same
    // route source yields different YAML on a CRLF checkout than on an LF one:
    // a multi-line summary comes out as a quoted scalar carrying literal CRs
    // instead of a block scalar. That made the generated artifact
    // checkout-dependent, which a drift gate cannot tolerate.
    .replace(/\r\n?/g, "\n")
    .replace(/^\/\/+/, "")
    .replace(/^\/\*+|\*+\/$/g, "")
    .trim();
  return cleaned.length ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// OpenAPI assembly
// ---------------------------------------------------------------------------

function tagFor(route: RouteInfo): string {
  return route.sourceFile.replace(/\.ts$/, "");
}

function buildOpenApi(routes: RouteInfo[]): Schema {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const pathItem = (paths[route.path] ??= {});
    const parameters: Schema[] = [];

    for (const name of route.pathParams) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      });
    }
    for (const name of route.queryParams) {
      parameters.push({
        name,
        in: "query",
        required: false,
        schema: { type: "string" },
      });
    }

    const operation: Schema = {
      summary: route.summary,
      tags: [tagFor(route)],
      operationId: `${route.method}_${route.path}`
        .replace(/[/{}]/g, "_")
        .replace(/_+/g, "_")
        .replace(/_$/, ""),
    };
    if (parameters.length) operation.parameters = parameters;

    if (route.method !== "get" && route.method !== "delete") {
      const schema: Schema = route.requestBody ?? { type: "object", additionalProperties: true };
      operation.requestBody = {
        required: route.requestBody ? !route.requestBodyOptional : false,
        content: { "application/json": { schema } },
      };
    }

    const responses: Record<string, unknown> = {};
    for (const status of route.responseStatuses) {
      responses[String(status)] = {
        description: status >= 400 ? "Error" : "Success",
        content: { "application/json": { schema: {} } },
      };
    }
    operation.responses = responses;

    pathItem[route.method] = operation;
  }

  // Stable ordering for a clean diff between runs.
  const orderedPaths: Record<string, unknown> = {};
  for (const key of Object.keys(paths).sort()) orderedPaths[key] = paths[key];

  return {
    openapi: "3.1.0",
    info: {
      title: "agentic-kanban REST API",
      version: readVersion(),
      description:
        "Auto-generated from Hono route source via scripts/generate-openapi.ts. " +
        "Schemas are inferred statically (best-effort) — request bodies come from the " +
        "parseJsonBody<T> type argument; response bodies are untyped.",
    },
    servers: [{ url: "/", description: "Same-origin (default dev: http://localhost:3001)" }],
    paths: orderedPaths,
  };
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * A short, human-readable account of where two YAML renderings diverge — enough for a
 * CI log to say WHAT drifted without dumping a 3000-line diff.
 */
function firstDifference(committed: string, generated: string): string {
  const a = committed.split("\n");
  const b = generated.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    lines.push(`  first difference at line ${i + 1}:`);
    lines.push(`    committed: ${a[i] === undefined ? "<end of file>" : JSON.stringify(a[i])}`);
    lines.push(`    generated: ${b[i] === undefined ? "<end of file>" : JSON.stringify(b[i])}`);
    break;
  }
  const paths = (src: string) =>
    new Set(src.split("\n").filter((l) => /^  \/\S/.test(l)).map((l) => l.trim().replace(/:$/, "")));
  const before = paths(committed);
  const after = paths(generated);
  const added = [...after].filter((p) => !before.has(p));
  const removed = [...before].filter((p) => !after.has(p));
  if (added.length) lines.push(`  ${added.length} path(s) missing from the committed spec, e.g. ${added.slice(0, 3).join(", ")}`);
  if (removed.length) lines.push(`  ${removed.length} path(s) in the committed spec no longer exist, e.g. ${removed.slice(0, 3).join(", ")}`);
  lines.push(`  (${a.length} committed lines vs ${b.length} generated)`);
  return lines.join("\n");
}

function main() {  loadIndexMounts();

  const routeFiles = fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();

  const allRoutes: RouteInfo[] = [...inlineRoutes];
  const unresolved: string[] = [];

  for (const file of routeFiles) {
    const sf = project.addSourceFileAtPath(path.join(routesDir, file));
    const exportedFactories = sf
      .getFunctions()
      .filter((fn) => fn.isExported() && /^create.*Route$/.test(fn.getName() ?? ""));

    for (const fn of exportedFactories) {
      const factoryName = fn.getName()!;
      const mount = factoryPrefixes.get(factoryName);
      const routerVar = findCreateRouterVar(fn);
      if (!routerVar) continue;
      if (!mount) {
        unresolved.push(`${file}: ${factoryName} is not mounted in routes/index.ts`);
        continue;
      }

      for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        if (expr.getExpression().getText() !== routerVar) continue;
        const member = expr.getName();
        if (!(HTTP_METHODS as readonly string[]).includes(member)) continue;
        const route = parseRouteCall(call, member as HttpMethod, mount.prefix, file);
        if (route) allRoutes.push(route);
        else unresolved.push(`${file}:${call.getStartLineNumber()} — non-literal path, skipped`);
      }
    }
  }

  // Codepoint order, NOT localeCompare: collation depends on the runtime's ICU
  // locale, so a de-DE dev box and an en-US CI runner can order the same routes
  // differently and the drift gate would fail for nobody's mistake.
  const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  allRoutes.sort((a, b) => byCodepoint(a.path, b.path) || byCodepoint(a.method, b.method));

  const doc = buildOpenApi(allRoutes);
  // Always LF. The committed blob is LF and git normalises the working tree back
  // to LF when diffing, so the drift gate compares like with like on either kind
  // of checkout.
  const yaml = YAML.stringify(doc, { lineWidth: 0 }).replace(/\r\n/g, "\n");

  const pathCount = new Set(allRoutes.map((r) => r.path)).size;

  // --check: the DRIFT GATE (#780). Regenerate in memory and compare against the
  // committed artifact instead of writing it. Before this existed, openapi.yaml had
  // not been regenerated since the commit that created it (2026-06-24) while 33
  // commits changed 33 distinct DTO files — a generated artifact nobody regenerates
  // and nobody diffs reads like a contract and is a two-month-old snapshot.
  if (process.argv.includes("--check")) {
    const committed = fs.existsSync(outputPath)
      ? fs.readFileSync(outputPath, "utf8").replace(/\r\n/g, "\n")
      : null;
    if (committed === yaml) {
      console.log(`✓ ${path.relative(serverRoot, outputPath)} is up to date (${allRoutes.length} operations across ${pathCount} paths)`);
      return;
    }
    console.error(`✗ ${path.relative(serverRoot, outputPath)} is OUT OF DATE with the route sources.`);
    if (committed === null) {
      console.error("  The file does not exist at all.");
    } else {
      console.error(firstDifference(committed, yaml));
    }
    console.error("");
    console.error("  Fix: run `pnpm openapi:generate` and commit packages/server/openapi.yaml.");
    console.error("  (If the only difference is `info.version`, a release bump left the spec");
    console.error("   behind — the same command fixes it.)");
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(outputPath, yaml, "utf8");
  console.log(`✓ Wrote ${path.relative(serverRoot, outputPath)}`);
  console.log(`  ${allRoutes.length} operations across ${pathCount} paths`);
  if (unresolved.length) {
    console.warn(`\n⚠ ${unresolved.length} item(s) could not be resolved:`);
    for (const u of unresolved) console.warn(`  - ${u}`);
  }
}

main();
