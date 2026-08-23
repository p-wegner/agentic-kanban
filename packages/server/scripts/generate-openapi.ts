/**
 * generate-openapi.ts — static OpenAPI 3.1 spec generator for the Hono REST API.
 *
 * The REST layer uses vanilla Hono (`router.get("/path", handler)`) with no
 * per-route schemas, so there is no runtime metadata to derive a spec from.
 * Instead we statically analyse the route source with ts-morph:
 *
 *   1. Parse `src/routes/index.ts` AND the composition roots (`src/startup/route-setup.ts`,
 *      `src/server-start.ts`) to map each `create<Name>Route` factory to the prefix it is
 *      mounted under (`routes.route("/projects", createProjectsRoute(...))`), plus any routes
 *      declared inline on those apps.
 *   2. For every `src/routes/*.ts` file, walk BOTH sanctioned shapes: a `create<Name>Route`
 *      factory around a `createRouter()` variable (paths relative to the mount prefix), and a
 *      `register<Name>Routes(app: Hono, ...)` function (paths already absolute).
 *   3. Per route, infer: path (+ `:param` -> `{param}`), path params, query params
 *      (from `c.req.query("x")`), request body shape (from the `parseJsonBody<T>(c)`
 *      / `parseOptionalJsonBody<T>(c)` type argument), and response status codes
 *      (from `c.json(body, status)`).
 *
 * Schemas are best-effort: types are read syntactically from the TS type literal,
 * not validated at runtime. Routes the analyser cannot resolve are reported to
 * stderr so coverage gaps are visible rather than silent.
 *
 * #805 - THE COVERAGE AUDIT, and why it is not optional. This generator used to scan
 * `src/routes/*.ts` only, while `startup/route-setup.ts` defined `POST /api/workspaces/:id/
 * review` inline and `routes/internal-monitor.ts` registered three `/api/internal/*` routes
 * on the app directly. None of them reached the spec. That is worse than a plain omission:
 * the run printed an `unresolved` list, so a reader reasonably concluded that anything NOT
 * on it was covered. A route the analyser never looks at is not unresolved - it is
 * invisible, and the report was a false assurance.
 *
 * So the generator now audits the WHOLE of `packages/server/src` for route-definition sites
 * (`<app>.get/post/put/patch/delete("<literal path>", handler)`) and classifies every one of
 * them as: in the spec, defined-but-never-mounted (reported), or DECLARED out of scope with a
 * written reason (`DECLARED_BLIND_SPOTS`). A site in none of those categories FAILS the run -
 * including under `--check`, so the drift gate catches it. The generator can therefore no
 * longer imply a coverage it does not have: either a route is in the spec, or the report
 * names it.
 *
 * Run: `pnpm openapi:generate` (writes packages/server/openapi.yaml).
 * Flags: `--check` (drift gate), `--spec <path>` (compare/write elsewhere),
 *        `--audit-extra-dir <dir>` (fold an extra tree into the coverage audit - the
 *        negative control that proves the audit bites).
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
  type SourceFile,
} from "ts-morph";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const srcDir = path.join(serverRoot, "src");
const routesDir = path.join(srcDir, "routes");

/**
 * Files that are NOT `src/routes/*.ts` yet legitimately register routes on a Hono app: the
 * composition roots. Mounting is their job (see `packages/server/CLAUDE.md`), and a route
 * MOUNTED there is as public as one mounted in `routes/index.ts`, so the generator reads
 * both. Route DEFINITIONS still belong in `src/routes/` - that rule is what #805 restored by
 * moving the review handler out of `route-setup.ts`.
 */
const COMPOSITION_ROOTS = ["src/startup/route-setup.ts", "src/server-start.ts"] as const;

export interface BlindSpot {
  /** Path relative to `packages/server`, e.g. `src/services/fleet-listener.service.ts`. */
  file: string;
  /** Restrict the exemption to ONE path literal in that file; omitted = the whole file. */
  pathLiteral?: string;
  reason: string;
}

/**
 * Route-definition sites this spec deliberately does not describe - each with the reason
 * written down. This list is the ONLY way a live route may be absent from the spec; anything
 * else fails the run. An entry is a claim a reviewer can disagree with, which is the point.
 */
export const DECLARED_BLIND_SPOTS: BlindSpot[] = [
  {
    file: "src/startup/route-setup.ts",
    pathLiteral: "*",
    reason:
      "SPA fallback - serves the client bundle for any path the API did not match. Not an API "
      + "operation, and `*` is not expressible as an OpenAPI path.",
  },
  {
    file: "src/services/fleet-listener.service.ts",
    reason:
      "A SEPARATE Hono app on KANBAN_FLEET_PORT (worker register/heartbeat/ws + the fleet MCP "
      + "bridge), never mounted on the board API. It has its own bearer-token auth and its own "
      + "surface; documenting its paths here would claim they exist on the board port, where "
      + "they do not.",
  },
];

/** The declared exemption covering `file`/`pathLiteral`, or undefined if there is none. */
export function isDeclaredBlindSpot(file: string, pathLiteral: string): BlindSpot | undefined {
  const normalised = file.replace(/\\/g, "/");
  return DECLARED_BLIND_SPOTS.find(
    (b) => normalised.endsWith(b.file) && (b.pathLiteral === undefined || b.pathLiteral === pathLiteral),
  );
}
/**
 * The spec to write (or, with `--check`, to compare against). Defaults to the committed
 * artifact; `--spec <path>` points it elsewhere so the drift gate's NEGATIVE control can
 * perturb a throwaway copy in `os.tmpdir()` instead of the real file. #814/#680: a test
 * that mutates a tracked file to prove a gate bites leaks that mutation whenever its
 * restore does not run, which dirties the shared checkout and blocks every auto-merge.
 */
const specFlagIndex = process.argv.indexOf("--spec");
const outputPath = specFlagIndex !== -1 && process.argv[specFlagIndex + 1]
  ? path.resolve(process.argv[specFlagIndex + 1]!)
  : path.join(serverRoot, "openapi.yaml");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** JSON-Schema-ish object we emit into the OpenAPI doc. */
type Schema = Record<string, unknown>;

interface RouteInfo {
  method: HttpMethod;
  /** Full path including `/api` prefix and `{param}` placeholders. */
  path: string;
  sourceFile: string;
  /** Path relative to `packages/server`, used to key the coverage audit. */
  sourceRel: string;
  line: number;
  pathParams: string[];
  queryParams: string[];
  requestBody?: Schema;
  /** true when body is parsed without a generic type argument (unknown shape). */
  requestBodyUnknown?: boolean;
  requestBodyOptional?: boolean;
  responseStatuses: number[];
  /** Statuses seen at a literal `c.json(body, status)` call site (plus the default fill). */
  inlineStatuses: number[];
  /** Statuses `domainErrorHandler` decides from an error the handler can throw (#826). */
  thrownStatuses: ThrownStatus[];
  summary: string;
}

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  compilerOptions: { allowJs: false },
});

// ---------------------------------------------------------------------------
// Step 1 — mount-prefix map from routes/index.ts
// ---------------------------------------------------------------------------

/**
 * Factory name (e.g. "createProjectsRoute") -> every FULL prefix it is mounted under (e.g.
 * "/api/projects"). A list, not a single value: `createSessionsRoute` is mounted from BOTH
 * `routes/index.ts` and `startup/route-setup.ts`, and a Map keyed by name would silently keep
 * whichever mount happened to be parsed last.
 */
const factoryPrefixes = new Map<string, string[]>();
/** inline routes declared directly on the aggregate router in createRoutes. */
const inlineRoutes: RouteInfo[] = [];

function addMount(factoryName: string, fullPrefix: string) {
  const list = factoryPrefixes.get(factoryName) ?? [];
  if (!list.includes(fullPrefix)) list.push(fullPrefix);
  factoryPrefixes.set(factoryName, list);
}

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
      addMount(factoryName, joinPaths("/api", prefix));
      continue;
    }

    // routes.post("/internal/...", handler) — inline routes on the aggregate router
    if (obj === aggregateRouterName && (HTTP_METHODS as readonly string[]).includes(member)) {
      const route = parseRouteCall(call, member as HttpMethod, "/api", sf.getBaseName(), "src/routes/index.ts");
      if (route) inlineRoutes.push(route);
    }
  }
}

/**
 * Mounts and inline routes declared on a Hono `app` in a COMPOSITION ROOT.
 *
 * #805: `startup/route-setup.ts` and `server-start.ts` both register live routes on the app
 * directly, and neither was ever scanned - so `POST /api/workspaces/:id/review`, the three
 * `/ws/*` upgrades and `GET /health` were absent from a spec that reported its own coverage.
 * Paths here are ABSOLUTE (the app has no prefix), which is the one thing that differs from
 * the `routes/index.ts` walk.
 */
function loadCompositionRootRoutes() {
  for (const rel of COMPOSITION_ROOTS) {
    const abs = path.join(serverRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const sf = project.addSourceFileAtPath(abs);
    const appVars = new Set<string>();
    for (const param of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
      if (param.getTypeNode()?.getText() === "Hono") appVars.add(param.getName());
    }
    for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init) && init.getExpression().getText() === "Hono") {
        appVars.add(decl.getName());
      }
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      if (!appVars.has(expr.getExpression().getText())) continue;
      const member = expr.getName();

      // app.route("/api/workspaces", createWorkspaceReviewRoute(...))
      if (member === "route") {
        const args = call.getArguments();
        const prefix = literalString(args[0]);
        const factoryArg = args[1];
        if (prefix === undefined || !factoryArg || !Node.isCallExpression(factoryArg)) continue;
        addMount(factoryArg.getExpression().getText(), joinPaths(prefix));
        continue;
      }

      if (!(HTTP_METHODS as readonly string[]).includes(member)) continue;
      const route = parseRouteCall(call, member as HttpMethod, "", sf.getBaseName(), rel);
      if (route) inlineRoutes.push(route);
    }
  }
}

/**
 * Every `<varName>.get/post/...("literal", handler)` inside `scope`, following calls to local
 * helper functions that take the router as their first argument.
 *
 * That last part is shape C, and #805 found it live: `routes/workers.ts` defines all twelve
 * worker endpoints in two private `registerXRoutes(router, ...)` helpers and its factory just
 * calls them, so a walk that only looked at `router.<method>` directly inside the factory saw
 * ZERO routes and reported nothing missing.
 */
function collectRouteCalls(
  scope: Node,
  varName: string,
  helpers: Map<string, { fn: Node; paramName: string }>,
  visited: Set<string> = new Set(),
): Array<{ call: CallExpression; method: HttpMethod }> {
  const found: Array<{ call: CallExpression; method: HttpMethod }> = [];
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();

    // helperFn(router, ...) — recurse into the helper with ITS parameter name.
    if (Node.isIdentifier(expr)) {
      const helper = helpers.get(expr.getText());
      const firstArg = call.getArguments()[0];
      if (helper && firstArg && firstArg.getText() === varName && !visited.has(expr.getText())) {
        visited.add(expr.getText());
        found.push(...collectRouteCalls(helper.fn, helper.paramName, helpers, visited));
      }
      continue;
    }

    if (!Node.isPropertyAccessExpression(expr)) continue;
    if (expr.getExpression().getText() !== varName) continue;
    const member = expr.getName();
    if (!(HTTP_METHODS as readonly string[]).includes(member)) continue;
    found.push({ call, method: member as HttpMethod });
  }
  return found;
}

/** Functions whose first parameter is a Hono app/router — the helper shape above. */
function honoHelpers(sf: Node): Map<string, { fn: Node; paramName: string }> {
  const helpers = new Map<string, { fn: Node; paramName: string }>();
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = fn.getName();
    const param = fn.getParameters()[0];
    if (!name || !param) continue;
    if (param.getTypeNode()?.getText() !== "Hono") continue;
    helpers.set(name, { fn, paramName: param.getName() });
  }
  return helpers;
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
  fullPrefix: string,
  sourceFile: string,
  sourceRel: string,
): RouteInfo | undefined {
  const args = call.getArguments();
  const subPath = literalString(args[0]);
  if (subPath === undefined) return undefined; // not a string-literal path - skip
  // A bare `*` is a catch-all mount (the SPA fallback), not an operation. A wildcard SEGMENT
  // (`/:id/docs/*`, which serves plugin docs) IS an operation, and dropping it silently is the
  // exact failure #805 is about — so it becomes a `{wildcard}` path parameter. OpenAPI has no
  // greedy-segment syntax, so this describes one segment where Hono matches the remainder;
  // that is an approximation, and a far smaller one than omitting the endpoint.
  const normalisedSubPath = subPath.replace(/\*/g, ":wildcard");
  if (normalisedSubPath === ":wildcard" || normalisedSubPath === "/:wildcard") return undefined;

  const handler = getHandler(call);
  const rawPath = joinPaths(fullPrefix, normalisedSubPath);
  const { openapiPath, pathParams } = convertPath(rawPath);

  const info: RouteInfo = {
    method,
    path: openapiPath,
    sourceFile,
    sourceRel,
    line: call.getStartLineNumber(),
    pathParams,
    queryParams: [],
    responseStatuses: [],
    inlineStatuses: [],
    thrownStatuses: [],
    summary: leadingComment(call) ?? `${method.toUpperCase()} ${openapiPath}`,
  };

  if (handler) analyseHandler(handler, info);
  if (info.responseStatuses.length === 0) {
    // A WebSocket upgrade answers 101, never 200, and its handler is a factory call rather
    // than an inline arrow so `analyseHandler` finds nothing. Saying 200 here would be a
    // small lie inside the artifact this ticket exists to make honest.
    info.responseStatuses = [openapiPath.startsWith("/ws/") ? 101 : 200];
  }
  info.inlineStatuses = [...new Set(info.responseStatuses)].sort((a, b) => a - b);
  // #826 — the statuses the ERROR MIDDLEWARE decides. A route that answers 404 by throwing
  // `NotFoundError` has no literal `c.json(…, 404)` for the walk above to see, so before this
  // the spec said nothing about it — and converting an inline error body onto the central
  // mapper (which `INLINE_ROUTE_ERROR_CAP` exists to encourage) DELETED the documented status.
  if (handler) info.thrownStatuses = thrownStatusesForHandler(handler);
  for (const thrown of info.thrownStatuses) info.responseStatuses.push(thrown.status);
  info.responseStatuses = [...new Set(info.responseStatuses)].sort((a, b) => a - b);
  info.queryParams = [...new Set(info.queryParams)];
  return info;
}

/**
 * How many hops `analyseHandler` will follow to find the body parse.
 *
 * A route file may wrap `parseJsonBody` in a local helper so it can re-shape the rejection
 * without losing the route's error identity -- `parsePluginBody` in `routes/plugins.ts` is the
 * case that forced this (#806): it catches `parseJsonBody`'s `HTTPException` and re-throws it
 * as a `PluginError` so the response keeps its machine-readable `code`. Scanning only the
 * handler's own descendants sees no `parseJsonBody` there and silently downgrades the
 * operation to "body optional, shape unknown" -- so hardening a route DELETED its request
 * schema and its 400 from the spec. One hop is what that pattern needs; it is bounded for the
 * same reason MAX_THROW_FOLLOW_DEPTH is, and a wrapper-of-a-wrapper is left unattributed
 * rather than chased.
 */
const MAX_BODY_FOLLOW_DEPTH = 1;

/** A same-file function called as a bare identifier -- the only shape this walk follows. */
function localFunctionCalled(call: Node, sf: SourceFile): Node | undefined {
  const expr = (call as CallExpression).getExpression();
  if (!Node.isIdentifier(expr)) return undefined;
  return findFunctionNamed(sf, expr.getText());
}

function analyseHandler(handler: Node, info: RouteInfo, depth = 0, seen = new Set<string>()) {
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

    // A local wrapper around the body parse (see MAX_BODY_FOLLOW_DEPTH). Only descend when the
    // handler has not already yielded a body: a direct parse in the handler is the stronger
    // signal and must not be overwritten by one found further down.
    if (depth < MAX_BODY_FOLLOW_DEPTH && info.requestBody === undefined && !info.requestBodyUnknown) {
      const sf = call.getSourceFile();
      const target = localFunctionCalled(call, sf);
      if (target) {
        const key = `${sf.getFilePath()}:${target.getStart()}`;
        if (!seen.has(key)) {
          seen.add(key);
          analyseHandler(target, info, depth + 1, seen);
        }
      }
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
// Middleware-decided error statuses (#826)
// ---------------------------------------------------------------------------

/**
 * How far past the handler body a thrown-error walk follows calls.
 *
 * Depth 2 = the handler itself, the functions it calls (a service method, `requireProject`,
 * `parseJsonBody`), and THOSE functions' callees. It is a precision choice, not a technical
 * limit: full transitive closure is easy and wrong — a git/exec helper five hops down that
 * throws NOT_FOUND for its own reasons would attach a 404 to every route that can reach it.
 * Two hops is where this codebase actually puts its existence checks; anything deeper is
 * counted as unfollowed and reported, rather than guessed at.
 */
const MAX_THROW_FOLLOW_DEPTH = 2;

/** A status the ERROR MIDDLEWARE decides, plus the domain code that decided it. */
export interface ThrownStatus {
  status: number;
  /** The `DomainErrorCode` / refusal code; absent for a bare `HTTPException(status)`. */
  code?: string;
}

export interface ErrorStatusMaps {
  /** `DomainErrorCode` -> HTTP status, parsed from `middleware/error-handler.ts`. */
  domainCodeStatus: Record<string, number>;
  /** Standalone refusal code -> status, parsed from `errors/index.ts`. */
  standaloneStatus: Record<string, number>;
  /** `NotFoundError` -> `{ status: 404, code: "NOT_FOUND" }`, parsed from `errors/index.ts`. */
  appErrorClasses: Record<string, { status: number; code: string }>;
}

function statusObjectLiteral(sf: SourceFile, name: string): Record<string, number> {
  const decl = sf.getVariableDeclaration(name);
  // `as const satisfies Record<string, number>` and a plain annotated literal both reduce to
  // the first object literal under the declaration — cheaper and more robust than unwrapping
  // every assertion wrapper the TS grammar allows.
  const obj = decl?.getFirstDescendantByKind(SyntaxKind.ObjectLiteralExpression);
  const out: Record<string, number> = {};
  for (const prop of obj?.getProperties() ?? []) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const value = prop.getInitializer();
    if (value && Node.isNumericLiteral(value)) {
      out[prop.getName().replace(/^["']|["']$/g, "")] = Number(value.getLiteralValue());
    }
  }
  return out;
}

/**
 * The status vocabulary, READ FROM THE MIDDLEWARE'S OWN SOURCE rather than restated here.
 *
 * A second copy of `DOMAIN_CODE_STATUS` in this generator would be a third place the mapping
 * lives (`errors/index.ts` declares the codes, the middleware maps them) and the first to go
 * stale — the exact drift #587 collapsed. `openapi-thrown-status.test.ts` compares what this
 * parses against the middleware's runtime export, so a rename or a moved table fails a test
 * instead of silently emptying the map and quietly deleting statuses from the spec.
 */
export function loadErrorStatusMaps(srcRoot: string = srcDir): ErrorStatusMaps {
  const reader = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false } });
  const handlerSf = reader.addSourceFileAtPath(path.join(srcRoot, "middleware/error-handler.ts"));
  const errorsSf = reader.addSourceFileAtPath(path.join(srcRoot, "errors/index.ts"));

  const appErrorClasses: ErrorStatusMaps["appErrorClasses"] = {};
  for (const cls of errorsSf.getClasses()) {
    const name = cls.getName();
    if (!name || cls.getExtends()?.getExpression().getText() !== "AppError") continue;
    const ctor = cls.getConstructors()[0];
    if (!ctor) continue;
    for (const call of ctor.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.SuperKeyword) continue;
      const args = call.getArguments();
      const status = args.find((a) => Node.isNumericLiteral(a));
      const code = args.find((a) => Node.isStringLiteral(a));
      if (status && code && Node.isNumericLiteral(status) && Node.isStringLiteral(code)) {
        appErrorClasses[name] = { status: Number(status.getLiteralValue()), code: code.getLiteralValue() };
      }
      break;
    }
  }

  return {
    domainCodeStatus: statusObjectLiteral(handlerSf, "DOMAIN_CODE_STATUS"),
    standaloneStatus: statusObjectLiteral(errorsSf, "STANDALONE_REFUSAL_STATUS"),
    appErrorClasses,
  };
}

/**
 * What the throw walk could NOT see, counted so the report says so out loud.
 *
 * `unfollowedCalls` is an UPPER BOUND on hidden throws, not a defect count: most of those
 * calls throw nothing. It exists because printing only the statuses that WERE found reads as
 * completeness — the #824 failure this generator has already made once.
 */
const throwWalkStats = { unfollowedCalls: 0, depthTruncatedCalls: 0, resolvedCalls: 0 };

/** Receivers whose methods are platform/library surface, never a domain throw worth following. */
const OPAQUE_RECEIVERS = new Set([
  "c", "console", "JSON", "Math", "Object", "Array", "Promise", "Number", "String",
  "Date", "process", "path", "fs", "Buffer", "Boolean", "Set", "Map", "res", "req",
]);

const moduleCache = new Map<string, SourceFile | null>();

/** Resolve a relative import specifier (`../services/x.js`) to a source file in this tree. */
function loadRelativeModule(fromFile: string, specifier: string): SourceFile | undefined {
  const key = `${fromFile} ${specifier}`;
  const cached = moduleCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const base = path.resolve(path.dirname(fromFile), specifier).replace(/\.js$/, "");
  let resolved: SourceFile | null = null;
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (!fs.existsSync(candidate)) continue;
    // Stay inside `packages/server/src`: a hop into `@agentic-kanban/shared` or node_modules
    // is exactly the plumbing depth this walk deliberately does not attribute.
    if (!candidate.startsWith(srcDir)) continue;
    resolved = project.getSourceFile(candidate) ?? project.addSourceFileAtPath(candidate);
    break;
  }
  moduleCache.set(key, resolved);
  return resolved ?? undefined;
}

/** The module a named import (value OR type) comes from, if it is a relative one. */
function moduleOfImport(sf: SourceFile, name: string): SourceFile | undefined {
  for (const imp of sf.getImportDeclarations()) {
    const specifier = imp.getModuleSpecifierValue();
    if (!specifier.startsWith(".")) continue;
    const names = imp.getNamedImports().map((n) => (n.getAliasNode() ?? n.getNameNode()).getText());
    if (!names.includes(name) && imp.getDefaultImport()?.getText() !== name) continue;
    return loadRelativeModule(sf.getFilePath(), specifier);
  }
  return undefined;
}

/**
 * `name` as re-exported by `sf`, following `export { name } from "./x.js"` and `export * from`.
 *
 * A split-responsibility refactor leaves the original module a pure facade that re-exports its
 * halves -- that is the mandated shape (#728/#819: "facade re-export from the original module
 * so no call site changes in the same commit"). A facade holds no function declarations, so
 * resolution stops dead there and every status thrown behind it silently leaves the spec. This
 * follows one re-export hop so the two refactorings compose instead of quietly cancelling.
 */
function followReExport(sf: SourceFile, name: string): { fn: Node; sf: SourceFile } | undefined {
  for (const exp of sf.getExportDeclarations()) {
    const specifier = exp.getModuleSpecifierValue();
    if (!specifier || !specifier.startsWith(".")) continue;
    const named = exp.getNamedExports().map((n) => (n.getAliasNode() ?? n.getNameNode()).getText());
    if (named.length && !named.includes(name)) continue; // a named re-export that is not this one
    const target = loadRelativeModule(sf.getFilePath(), specifier);
    if (!target) continue;
    const fn = findFunctionNamed(target, name);
    if (fn) return { fn, sf: target };
  }
  return undefined;
}

/** A function/method named `name` anywhere in `sf` — service factories nest theirs, so search deep. */
function findFunctionNamed(sf: SourceFile, name: string): Node | undefined {
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (fn.getName() === name) return fn;
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== name) continue;
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  for (const cls of sf.getClasses()) {
    const method = cls.getMethod(name);
    if (method) return method;
  }
  return undefined;
}

/**
 * The module behind `recv` in `recv.method(...)`.
 *
 * Two shapes cover the services this API is built from, and both are purely syntactic — no
 * type checker, so no full program to load:
 *   `const projectService = createProjectService({…})` -> the module `createProjectService`
 *      is imported from;
 *   `function createXRoute(projectService: ProjectService, …)` -> the module the TYPE
 *      `ProjectService` is imported from.
 */
function moduleOfReceiver(sf: SourceFile, receiver: string): SourceFile | undefined {
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() !== receiver) continue;
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init)) {
      const factory = init.getExpression().getText();
      return moduleOfImport(sf, factory) ?? (findFunctionNamed(sf, factory) ? sf : undefined);
    }
  }
  for (const param of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
    if (param.getName() !== receiver) continue;
    const typeName = param.getTypeNode()?.getText().replace(/<[\s\S]*$/, "").trim();
    if (typeName) return moduleOfImport(sf, typeName);
  }
  return undefined;
}

/** The function a call expression targets, when it can be resolved syntactically. */
function resolveCallTarget(call: CallExpression, sf: SourceFile): { fn: Node; sf: SourceFile } | undefined {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    const local = findFunctionNamed(sf, name);
    if (local) return { fn: local, sf };
    const module = moduleOfImport(sf, name);
    if (!module) return undefined;
    const fn = findFunctionNamed(module, name);
    return fn ? { fn, sf: module } : followReExport(module, name);
  }
  if (!Node.isPropertyAccessExpression(expr)) return undefined;
  const receiverNode = expr.getExpression();
  if (!Node.isIdentifier(receiverNode)) return undefined;
  const receiver = receiverNode.getText();
  if (OPAQUE_RECEIVERS.has(receiver)) return undefined;
  const module = moduleOfReceiver(sf, receiver);
  if (!module) return undefined;
  const fn = findFunctionNamed(module, expr.getName());
  return fn ? { fn, sf: module } : followReExport(module, expr.getName());
}

/**
 * True when `node` sits in a `try` block whose `catch` cannot rethrow.
 *
 * The cheapest honest guard against OVER-documenting: a throw the handler swallows never
 * reaches the middleware, so claiming its status would be a fresh untruth in the artifact
 * this ticket exists to make honest. A catch containing any `throw` is treated as
 * propagating, which is what every catch in this tree does.
 */
function isSwallowed(node: Node, scope: Node): boolean {
  let cur: Node | undefined = node.getParent();
  while (cur && cur.getStart() >= scope.getStart() && cur.getEnd() <= scope.getEnd()) {
    if (Node.isTryStatement(cur)) {
      const block = cur.getTryBlock();
      const inTry = node.getStart() >= block.getStart() && node.getEnd() <= block.getEnd();
      const catchClause = cur.getCatchClause();
      if (inTry && catchClause && catchClause.getDescendantsOfKind(SyntaxKind.ThrowStatement).length === 0) {
        return true;
      }
    }
    cur = cur.getParent();
  }
  return false;
}

/** A class declared in this tree whose instances carry a literal `code` field. */
function classFieldCode(sf: SourceFile, className: string): string | undefined {
  const module = moduleOfImport(sf, className) ?? sf;
  const cls = module.getClass(className);
  const init = cls?.getProperty("code")?.getInitializer();
  return init && Node.isStringLiteral(init) ? init.getLiteralValue() : undefined;
}

/** The status a `throw new …` produces once `domainErrorHandler` has seen it. */
function statusOfThrow(stmt: Node, sf: SourceFile, maps: ErrorStatusMaps): ThrownStatus | undefined {
  if (!Node.isThrowStatement(stmt)) return undefined;
  const expr = stmt.getExpression();
  if (!expr || !Node.isNewExpression(expr)) return undefined;
  const className = expr.getExpression().getText();
  const args = expr.getArguments();

  if (className === "HTTPException") {
    const first = args[0];
    return first && Node.isNumericLiteral(first) ? { status: Number(first.getLiteralValue()) } : undefined;
  }

  const known = maps.appErrorClasses[className];
  if (known) return { status: known.status, code: known.code };

  // `new ProjectError("Project not found", "NOT_FOUND")` — the code travels as a literal
  // argument, the shape every service-local error class uses (#587).
  for (const arg of args) {
    if (!Node.isStringLiteral(arg)) continue;
    const value = arg.getLiteralValue();
    if (value in maps.domainCodeStatus) return { status: maps.domainCodeStatus[value]!, code: value };
    if (value in maps.standaloneStatus) return { status: maps.standaloneStatus[value]!, code: value };
  }

  // `readonly code = "NO_AVAILABLE_WORKER"` — a field initializer, never an argument (#692).
  const fieldCode = classFieldCode(sf, className);
  if (fieldCode) {
    if (fieldCode in maps.domainCodeStatus) return { status: maps.domainCodeStatus[fieldCode]!, code: fieldCode };
    if (fieldCode in maps.standaloneStatus) return { status: maps.standaloneStatus[fieldCode]!, code: fieldCode };
  }
  return undefined;
}

const throwWalkCache = new Map<string, ThrownStatus[]>();

/** Every middleware-decided status reachable from `scope`, following calls to `MAX_THROW_FOLLOW_DEPTH`. */
function collectThrownStatuses(
  scope: Node,
  sf: SourceFile,
  maps: ErrorStatusMaps,
  depth: number,
  active: Set<string>,
): ThrownStatus[] {
  const cacheKey = `${sf.getFilePath()}:${scope.getStart()}:${depth}`;
  const cached = throwWalkCache.get(cacheKey);
  if (cached) return cached;
  if (active.has(cacheKey)) return []; // recursion — the cycle contributes nothing new
  active.add(cacheKey);

  const found: ThrownStatus[] = [];
  for (const stmt of scope.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    if (isSwallowed(stmt, scope)) continue;
    const status = statusOfThrow(stmt, sf, maps);
    if (status) found.push(status);
  }

  // A schema-validated body rejects with `HTTPException(400)` raised INSIDE `parseJsonBody`,
  // not with a `throw` the handler owns -- so #806's hardening deleted 21 documented 400s from
  // this spec by replacing hand-written `if (!x) throw new SomeError(...)` guards it could
  // read. The endpoints still answer 400; only the evidence moved. Two-argument form only:
  // `parseJsonBody(c)` with no schema parses without validating and cannot reject on shape.
  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isSwallowed(call, scope)) continue;
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee) || callee.getText() !== "parseJsonBody") continue;
    if (call.getArguments().length < 2) continue;
    found.push({ status: 400 });
  }

  for (const call of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isSwallowed(call, scope)) continue;
    const expr = call.getExpression();
    // A method call on an opaque receiver (`c.json`, `console.error`) is not an "unfollowed
    // domain call" and must not inflate the honesty counter into meaninglessness.
    if (Node.isPropertyAccessExpression(expr)) {
      const receiver = expr.getExpression();
      if (!Node.isIdentifier(receiver) || OPAQUE_RECEIVERS.has(receiver.getText())) continue;
    } else if (!Node.isIdentifier(expr)) {
      continue;
    }
    if (depth >= MAX_THROW_FOLLOW_DEPTH) {
      throwWalkStats.depthTruncatedCalls++;
      continue;
    }
    const target = resolveCallTarget(call, sf);
    if (!target) {
      throwWalkStats.unfollowedCalls++;
      continue;
    }
    throwWalkStats.resolvedCalls++;
    found.push(...collectThrownStatuses(target.fn, target.sf, maps, depth + 1, active));
  }

  active.delete(cacheKey);
  const deduped: ThrownStatus[] = [];
  for (const s of found) {
    if (!deduped.some((d) => d.status === s.status && d.code === s.code)) deduped.push(s);
  }
  throwWalkCache.set(cacheKey, deduped);
  return deduped;
}

/** Lazily loaded once — the maps are read from source, so every route walk shares them. */
let errorStatusMaps: ErrorStatusMaps | undefined;
function thrownStatusesForHandler(handler: Node): ThrownStatus[] {
  errorStatusMaps ??= loadErrorStatusMaps();
  return collectThrownStatuses(handler, handler.getSourceFile(), errorStatusMaps, 0, new Set());
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
// Coverage audit (#805) - every route-definition site in the tree, classified
// ---------------------------------------------------------------------------

export interface RouteSite {
  /** Path relative to the audit root, forward slashes (e.g. `src/routes/issues.ts`). */
  rel: string;
  line: number;
  method: string;
  pathLiteral: string;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests build throwaway Hono apps constantly; they are not part of the public surface.
      if (["__tests__", "node_modules", "dist", ".git"].includes(entry.name)) continue;
      walkTsFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every `<something>.get|post|put|patch|delete("<literal path>", handler)` in `dir`.
 *
 * Deliberately SHAPE-based rather than tied to the shapes the generator knows how to
 * resolve: the whole point of #805 is to notice a route defined somewhere the resolver was
 * never taught about. A one-argument `map.get("key")` is excluded by requiring a second
 * argument and a path that starts with `/` (or is the `*` catch-all).
 */
export function findRouteDefinitionSites(dir: string, relRoot: string = dir): RouteSite[] {
  const scanner = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false } });
  const sites: RouteSite[] = [];
  for (const file of walkTsFiles(dir)) {
    const sf = scanner.addSourceFileAtPath(file);
    const rel = path.relative(relRoot, file).replace(/\\/g, "/");
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const member = expr.getName();
      if (!(HTTP_METHODS as readonly string[]).includes(member)) continue;
      const args = call.getArguments();
      if (args.length < 2) continue;
      const lit = literalString(args[0]);
      if (lit === undefined) continue;
      if (!lit.startsWith("/") && lit !== "*") continue;
      sites.push({ rel, line: call.getStartLineNumber(), method: member, pathLiteral: lit });
    }
  }
  return sites.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
}

export interface CoverageReport {
  total: number;
  inSpec: RouteSite[];
  declared: Array<{ site: RouteSite; reason: string }>;
  unmounted: RouteSite[];
  undeclared: RouteSite[];
}

export function classifyRouteSites(
  sites: RouteSite[],
  emittedKeys: Set<string>,
  unmountedKeys: Set<string>,
): CoverageReport {
  const report: CoverageReport = { total: sites.length, inSpec: [], declared: [], unmounted: [], undeclared: [] };
  for (const site of sites) {
    const key = `${site.rel}:${site.line}`;
    if (emittedKeys.has(key)) {
      report.inSpec.push(site);
      continue;
    }
    const declared = isDeclaredBlindSpot(site.rel, site.pathLiteral);
    if (declared) {
      report.declared.push({ site, reason: declared.reason });
      continue;
    }
    if (unmountedKeys.has(key)) {
      report.unmounted.push(site);
      continue;
    }
    report.undeclared.push(site);
  }
  return report;
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
      // `required` follows WHETHER a body is parsed, not whether its SHAPE could be read.
      // `parseJsonBody(c, zodSchema)` (#806) carries no type argument, so the shape is unknown
      // while the body is still mandatory -- keying off `requestBody` alone documented those
      // operations as `required: false`, which is a false statement about the endpoint rather
      // than a gap in the spec. An unknown shape is an omission; "optional" is a lie.
      const parsesBody = route.requestBody !== undefined || route.requestBodyUnknown === true;
      operation.requestBody = {
        required: parsesBody ? !route.requestBodyOptional : false,
        content: { "application/json": { schema } },
      };
    }

    // #826 — a status ONLY the error middleware produces says so, and names the domain code
    // that decided it. Provenance in the artifact is the point: a reader can tell a status the
    // handler returns itself from one `domainErrorHandler` maps out of a thrown error, and the
    // codes are the same vocabulary the response body now echoes (#823).
    const thrownOnly = new Map<number, Set<string>>();
    for (const thrown of route.thrownStatuses) {
      if (route.inlineStatuses.includes(thrown.status)) continue;
      const codes = thrownOnly.get(thrown.status) ?? new Set<string>();
      codes.add(thrown.code ?? "HTTPException");
      thrownOnly.set(thrown.status, codes);
    }

    const responses: Record<string, unknown> = {};
    for (const status of route.responseStatuses) {
      const codes = thrownOnly.get(status);
      const description = codes
        ? `Error (thrown ${[...codes].sort().join(", ")}, status from domainErrorHandler)`
        : status >= 400 ? "Error" : "Success";
      // A 101 carries no body at all — claiming an application/json response for a WebSocket
      // upgrade would be a fresh small untruth in the artifact this ticket exists to fix.
      responses[String(status)] = status === 101
        ? { description: "Switching Protocols (WebSocket upgrade)" }
        : { description, content: { "application/json": { schema: {} } } };
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
        "parseJsonBody<T> type argument; response bodies are untyped. Coverage is audited: " +
        "see x-coverage for what is scanned and what is deliberately not described here.",
    },
    servers: [{ url: "/", description: "Same-origin (default dev: http://localhost:3001)" }],
    // #805 - the artifact states its own coverage instead of leaving a reader to infer it
    // from a silent absence. Everything route-shaped in `packages/server/src` is either a
    // path below or an entry here; the generator fails rather than emit a third case.
    "x-coverage": {
      scanned: ["src/routes/*.ts", ...COMPOSITION_ROOTS],
      notDocumented: DECLARED_BLIND_SPOTS.map((b) => ({
        where: b.pathLiteral === undefined ? b.file : `${b.file} (\`${b.pathLiteral}\`)`,
        reason: b.reason,
      })),
      // #826 - error responses are only PARTLY derivable, and the artifact says which part.
      // Before this, an operation's statuses came from literal `c.json(body, status)` sites
      // alone, so a route that answers 404 by THROWING documented no 404 at all - and moving
      // an inline error body onto the central mapper silently deleted a documented status.
      errorResponses: {
        mechanism:
          "Routes built on `createRouter()` install `domainErrorHandler`, which maps a thrown "
          + "error's domain code to a status (DOMAIN_CODE_STATUS) and echoes the code in the "
          + "body as `{ error, code }`.",
        derivedFrom:
          "Statuses are attributed by statically following `throw new ...` from each handler up "
          + `to ${MAX_THROW_FOLLOW_DEPTH} call(s) deep, mapping the code through the tables `
          + "parsed from `middleware/error-handler.ts` and `errors/index.ts`.",
        limitations: [
          `Attribution stops at ${MAX_THROW_FOLLOW_DEPTH} hops from the handler: an error thrown `
          + "deeper in a service call chain is NOT documented here. The bound is deliberate - "
          + "unbounded following would attach a plumbing helper's 404 to every route that can "
          + "reach it.",
          "A call whose target cannot be resolved syntactically (a callback parameter, a "
          + "dynamically dispatched method, anything imported from another package) is not "
          + "followed, so statuses it can throw are absent.",
          "Every operation may additionally answer 500: domainErrorHandler's final branch "
          + "renders any unrecognised error as `{ error }` with status 500. That is not listed "
          + "per-operation because it is true of all of them.",
          "A throw inside a `try` whose `catch` contains no `throw` is treated as swallowed and "
          + "is not attributed.",
        ],
      },
    },
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

/** The coverage report, printed on every run so the claim is never implicit. */
function printCoverage(coverage: CoverageReport) {
  console.log(
    `  route coverage: ${coverage.total} definition site(s) — ${coverage.inSpec.length} in the spec, `
    + `${coverage.declared.length} declared out of scope, ${coverage.unmounted.length} defined but never mounted, `
    + `${coverage.undeclared.length} undeclared`,
  );
  for (const { site, reason } of coverage.declared) {
    console.log(`    out of scope: ${site.rel}:${site.line} ${site.method.toUpperCase()} ${site.pathLiteral} — ${reason}`);
  }
  for (const site of coverage.unmounted) {
    console.log(`    never mounted: ${site.rel}:${site.line} ${site.method.toUpperCase()} ${site.pathLiteral}`);
  }
}

/**
 * What the thrown-status attribution saw and what it did NOT (#826).
 *
 * Printed on every run for the same reason as the coverage report above: a generator that
 * lists what it found and stays quiet about what it skipped reads as complete. These two
 * numbers are the honest bound - each is a call site whose throws are simply not in the spec.
 */
function printThrowAttribution(routes: RouteInfo[]) {
  const withDerived = routes.filter((r) => r.thrownStatuses.some((t) => !r.inlineStatuses.includes(t.status)));
  const derivedStatuses = withDerived.reduce(
    (n, r) => n + new Set(r.thrownStatuses.filter((t) => !r.inlineStatuses.includes(t.status)).map((t) => t.status)).size,
    0,
  );
  console.log(
    `  error attribution: ${withDerived.length} operation(s) document ${derivedStatuses} middleware-decided `
    + `status(es) (walk depth ${MAX_THROW_FOLLOW_DEPTH}, ${throwWalkStats.resolvedCalls} call(s) followed)`,
  );
  console.log(
    `    NOT attributed: ${throwWalkStats.unfollowedCalls} unresolvable call(s) + `
    + `${throwWalkStats.depthTruncatedCalls} beyond the depth bound — any status they throw is absent `
    + "from the spec (an upper bound: most of those calls throw nothing).",
  );
}

function main() {
  loadIndexMounts();
  loadCompositionRootRoutes();

  const routeFiles = fs
    .readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();

  const allRoutes: RouteInfo[] = [...inlineRoutes];
  const unresolved: string[] = [];
  /**
   * Route calls inside a factory nothing mounts. They are unreachable, so their absence from
   * the spec is correct — but it must be SAID, or the audit below would report them as an
   * undeclared blind spot and a dead factory would block every regeneration.
   */
  const unmountedKeys = new Set<string>();
  /**
   * Factories nothing mounts, held back until `emittedKeys` exists (#824).
   *
   * "This factory is not mounted" is NOT the same claim as "these routes are undocumented",
   * and reporting the first as if it were the second is how this generator grew a permanent
   * warning. `routes/workers.ts` exports two factories over ONE set of route definitions:
   * `createWorkersRoute` (owner + worker-facing, mounted on the board API at `/api/workers`)
   * and `createFleetWorkersRoute` (the worker-facing SUBSET, mounted on the off-loopback fleet
   * app via a property — `createWorkersRoute: createFleetWorkersRoute` in `server-start.ts` —
   * an indirection this analyser cannot follow, and the residual limit #805 disclosed).
   *
   * Every path the second factory serves is therefore already in the spec via the first, and
   * the coverage audit agreed all along: it classified those sites `inSpec`, because
   * `emittedKeys` is checked before `unmountedKeys`. Only the human-facing warning disagreed.
   *
   * So the decision needs `emittedKeys`, which is not built until every file has been walked.
   * Deferring also makes the check order-independent: whether the mounted factory happens to
   * be visited before the unmounted one, in the same file or another, no longer changes the
   * output.
   *
   * A factory whose routes are genuinely nowhere still warns — that path is #820, where the
   * report was right and a client feature had been 404-ing.
   */
  const unmountedFactories: Array<{ message: string; keys: string[] }> = [];

  for (const file of routeFiles) {
    const rel = `src/routes/${file}`;
    const sf = project.addSourceFileAtPath(path.join(routesDir, file));
    const helpers = honoHelpers(sf);
    /** Helpers reached from a factory, so their paths are RELATIVE to that factory's mount. */
    const helperUsedByFactory = new Set<string>();

    const emit = (calls: Array<{ call: CallExpression; method: HttpMethod }>, prefix: string) => {
      for (const { call, method } of calls) {
        const route = parseRouteCall(call, method, prefix, file, rel);
        if (route) allRoutes.push(route);
        else unresolved.push(`${file}:${call.getStartLineNumber()} — catch-all or non-literal path, skipped`);
      }
    };

    // Shape A — `create<X>Route(…)` around a `createRouter()` variable, mounted under a prefix
    // (possibly via shape-C helpers, see `collectRouteCalls`).
    for (const fn of sf.getFunctions()) {
      const fnName = fn.getName() ?? "";
      if (!fn.isExported() || !/^create.*Route$/.test(fnName)) continue;
      const routerVar = findCreateRouterVar(fn);
      if (!routerVar) continue;

      for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (Node.isIdentifier(expr) && helpers.has(expr.getText())) helperUsedByFactory.add(expr.getText());
      }

      const calls = collectRouteCalls(fn, routerVar, helpers);
      const mounts = factoryPrefixes.get(fnName);
      if (!mounts || mounts.length === 0) {
        unmountedFactories.push({
          message: `${file}: ${fnName} is not mounted in routes/index.ts or a composition root`,
          keys: calls.map(({ call }) => `${rel}:${call.getStartLineNumber()}`),
        });
        continue;
      }
      for (const prefix of mounts) emit(calls, prefix);
    }

    // Shape B — an EXPORTED `register<X>Routes(app: Hono, …)` nobody's factory consumes: it is
    // called by a composition root with the top-level app, so its paths are already absolute.
    // #805 found three live `/api/internal/*` routes in exactly this shape
    // (`routes/internal-monitor.ts`) that no version of this generator had ever seen.
    for (const [name, helper] of helpers) {
      if (helperUsedByFactory.has(name)) continue;
      const decl = sf.getFunction(name);
      if (!decl?.isExported()) continue;
      emit(collectRouteCalls(helper.fn, helper.paramName, helpers), "");
    }
  }

  // Codepoint order, NOT localeCompare: collation depends on the runtime's ICU
  // locale, so a de-DE dev box and an en-US CI runner can order the same routes
  // differently and the drift gate would fail for nobody's mistake.
  const byCodepoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  allRoutes.sort((a, b) => byCodepoint(a.path, b.path) || byCodepoint(a.method, b.method));

  // One factory can be mounted under the same prefix twice (`createSessionsRoute` is mounted
  // from both `routes/index.ts` and `route-setup.ts`), which would double-count operations.
  const seen = new Set<string>();
  const uniqueRoutes = allRoutes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ---- the coverage audit (#805) --------------------------------------------------------
  const emittedKeys = new Set(allRoutes.map((r) => `${r.sourceRel}:${r.line}`));

  // Now that every file has been walked, decide which unmounted factories are actually a
  // coverage problem: one whose route definitions ALL reach the spec through some other mount
  // documents the same paths and is silent (#824). Anything else warns and feeds the audit.
  for (const factory of unmountedFactories) {
    const undocumented = factory.keys.filter((key) => !emittedKeys.has(key));
    if (undocumented.length === 0) continue;
    unresolved.push(
      undocumented.length === factory.keys.length
        ? factory.message
        : `${factory.message} (${undocumented.length} of ${factory.keys.length} of its routes reach the spec via no other mount)`,
    );
    for (const key of undocumented) unmountedKeys.add(key);
  }
  const sites = findRouteDefinitionSites(srcDir, serverRoot);
  const extraIndex = process.argv.indexOf("--audit-extra-dir");
  if (extraIndex !== -1 && process.argv[extraIndex + 1]) {
    // The negative control: fold a throwaway tree into the audit and watch it fail. Proving
    // the gate bites this way needs no writable file in the checkout (see #814).
    const extra = path.resolve(process.argv[extraIndex + 1]!);
    sites.push(...findRouteDefinitionSites(extra, extra));
  }
  const coverage = classifyRouteSites(sites, emittedKeys, unmountedKeys);

  const doc = buildOpenApi(uniqueRoutes);
  // Always LF. The committed blob is LF and git normalises the working tree back
  // to LF when diffing, so the drift gate compares like with like on either kind
  // of checkout.
  const yaml = YAML.stringify(doc, { lineWidth: 0 }).replace(/\r\n/g, "\n");

  const pathCount = new Set(uniqueRoutes.map((r) => r.path)).size;

  if (coverage.undeclared.length) {
    console.error(`✗ ${coverage.undeclared.length} route definition site(s) are in NEITHER the spec nor the declared exceptions:`);
    for (const site of coverage.undeclared) {
      console.error(`  - ${site.rel}:${site.line} ${site.method.toUpperCase()} ${site.pathLiteral}`);
    }
    console.error("");
    console.error("  A route the generator does not scan is INVISIBLE, not `unresolved` — and an");
    console.error("  `unresolved` list that omits it reads as full coverage (#805). Pick one:");
    console.error("    1. move the definition into `src/routes/` (a `create<X>Route` factory, or a");
    console.error("       `register<X>Routes(app)` function) so the spec describes it — preferred;");
    console.error("    2. add the file to `COMPOSITION_ROOTS` if it is genuinely a composition root;");
    console.error("    3. add it to `DECLARED_BLIND_SPOTS` WITH a reason, if it must not be described.");
    process.exitCode = 1;
    return;
  }

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
      console.log(`✓ ${path.relative(serverRoot, outputPath)} is up to date (${uniqueRoutes.length} operations across ${pathCount} paths)`);
      printCoverage(coverage);
      printThrowAttribution(uniqueRoutes);
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
  console.log(`  ${uniqueRoutes.length} operations across ${pathCount} paths`);
  printCoverage(coverage);
  printThrowAttribution(uniqueRoutes);
  if (unresolved.length) {
    console.warn(`\n⚠ ${unresolved.length} item(s) could not be resolved:`);
    for (const u of unresolved) console.warn(`  - ${u}`);
  }
}

// Importable for the coverage guard suite (`openapi-route-coverage.test.ts`) without running
// a generation on import.
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) main();
