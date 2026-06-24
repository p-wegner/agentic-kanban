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

function main() {
  loadIndexMounts();

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

  allRoutes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const doc = buildOpenApi(allRoutes);
  const yaml = YAML.stringify(doc, { lineWidth: 0 });
  fs.writeFileSync(outputPath, yaml, "utf8");

  const pathCount = new Set(allRoutes.map((r) => r.path)).size;
  console.log(`✓ Wrote ${path.relative(serverRoot, outputPath)}`);
  console.log(`  ${allRoutes.length} operations across ${pathCount} paths`);
  if (unresolved.length) {
    console.warn(`\n⚠ ${unresolved.length} item(s) could not be resolved:`);
    for (const u of unresolved) console.warn(`  - ${u}`);
  }
}

main();
