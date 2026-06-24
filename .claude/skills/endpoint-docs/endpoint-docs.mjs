#!/usr/bin/env node
/**
 * endpoint-docs — maintain & query a concise Markdown catalog of the REST API.
 *
 * The catalog (docs/api/endpoints.md) is a parseable, per-tag table of every
 * Hono endpoint: Method | Path | Request | Response | Description. Its YAML
 * frontmatter records the commit SHA + timestamp of the last analysis, so the
 * `check` command can tell — cheaply, via `git diff` scoped to route files —
 * whether the doc has drifted from the code.
 *
 * Commands:
 *   build              (re)generate the catalog from source
 *   update             rebuild and print a changelog vs the current catalog
 *   check              is the catalog stale? lists changed route files since the
 *                      recorded SHA (exit 1 if stale — hook/CI friendly)
 *   list [--tag T]     list all endpoints (or one tag)
 *   find <query>       substring search over path/desc/request/response
 *   get <method> <path>  exact lookup of one endpoint
 *   usage <path>       where the endpoint is called from (client/server/mcp/cli)
 *
 * Add --json to list/find/get/usage/check for machine-readable output.
 *
 * Self-contained: ts-morph (needed only by build/update) is loaded lazily from
 * the server package; the query commands have no dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Project layout
// ---------------------------------------------------------------------------

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const DOC_PATH = path.join(REPO_ROOT, "docs", "api", "endpoints.md");
const ROUTES_DIR = path.join(REPO_ROOT, "packages", "server", "src", "routes");
/** pathspec used to scope `git diff` and to record in frontmatter. */
const SOURCE_PATHSPEC = "packages/server/src/routes";
/** dirs scanned by `usage`. */
const USAGE_DIRS = [
  "packages/client/src",
  "packages/server/src",
  "packages/mcp-server/src",
];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", cwd: REPO_ROOT, ...opts });
}

function headSha() {
  return git(["rev-parse", "HEAD"]).trim();
}

/** Route files changed between `sha` and HEAD, or null if `sha` is unusable. */
function changedRouteFiles(sha) {
  try {
    const out = git(["diff", "--name-only", `${sha}..HEAD`, "--", SOURCE_PATHSPEC]);
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

// ===========================================================================
// ANALYSIS (ts-morph) — only loaded for build/update
// ===========================================================================

let _tsm = null;
function tsMorph() {
  if (_tsm) return _tsm;
  const requireFromServer = createRequire(path.join(REPO_ROOT, "packages", "server", "package.json"));
  _tsm = requireFromServer("ts-morph");
  return _tsm;
}

function literalString(node, Node) {
  return node && Node.isStringLiteral(node) ? node.getLiteralValue() : undefined;
}

function joinPaths(...parts) {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return "/" + joined;
}

function convertPath(p) {
  const pathParams = [];
  const openapiPath = p.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => {
    pathParams.push(name);
    return `{${name}}`;
  });
  return { openapiPath, pathParams };
}

/** Leading comment(s) above the call, joined and stripped of any `METHOD /path —` prefix. */
function semanticComment(call, SyntaxKind) {
  const stmt = call.getFirstAncestorByKind(SyntaxKind.ExpressionStatement) ?? call;
  const ranges = stmt.getLeadingCommentRanges();
  if (!ranges.length) return "";
  // Join the last few contiguous comment lines (the route's own doc-comment).
  let text = ranges
    .slice(-3)
    .map((r) => r.getText().replace(/^\/\/+/, "").replace(/^\/\*+|\*+\/$/g, "").trim())
    .join(" ")
    .trim();
  // Drop a leading "METHOD /path[ — separator]" so only the semantic remains.
  const m = text.match(/^(GET|POST|PUT|PATCH|DELETE)\s+\/\S*\s*(.*)$/i);
  if (m) text = m[2].replace(/^[—–:_-]+\s*/, "").trim();
  return text.slice(0, 200).trim();
}

function findRouterVar(scope, SyntaxKind, Node) {
  for (const decl of scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (init && Node.isCallExpression(init) && init.getExpression().getText() === "createRouter") {
      return decl.getName();
    }
  }
  return undefined;
}

function getHandler(call, Node) {
  const args = call.getArguments();
  for (let i = args.length - 1; i >= 0; i--) {
    if (Node.isArrowFunction(args[i]) || Node.isFunctionExpression(args[i])) return args[i];
  }
  return undefined;
}

function requestName(handler, method, SyntaxKind, Node) {
  if (method === "get" || method === "delete") return "—";
  for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const name = Node.isIdentifier(expr)
      ? expr.getText()
      : Node.isPropertyAccessExpression(expr)
        ? expr.getName()
        : undefined;
    if (name !== "parseJsonBody" && name !== "parseOptionalJsonBody") continue;
    const typeArg = call.getTypeArguments()[0];
    if (!typeArg) return "json";
    if (Node.isTypeLiteral(typeArg)) {
      const props = typeArg
        .getMembers()
        .filter((m) => Node.isPropertySignature(m))
        .map((m) => m.getName() + (m.hasQuestionToken() ? "?" : ""));
      return braceList(props);
    }
    return typeArg.getText().replace(/\s+/g, " ").slice(0, 60);
  }
  return "—";
}

function braceList(names) {
  if (!names.length) return "{}";
  const shown = names.slice(0, 5);
  return "{" + shown.join(", ") + (names.length > 5 ? ", …" : "") + "}";
}

/** Unwrap `await`, and `wrapAiOperation("x", () => realCall())` to the real producer. */
function unwrapExpr(expr, Node) {
  let e = expr;
  if (Node.isAwaitExpression(e)) e = e.getExpression();
  if (Node.isCallExpression(e)) {
    const callee = e.getExpression();
    const calleeName = Node.isPropertyAccessExpression(callee)
      ? callee.getName()
      : Node.isIdentifier(callee)
        ? callee.getText()
        : "";
    if (calleeName === "wrapAiOperation") {
      const inner = e.getArguments()[e.getArguments().length - 1];
      if (inner && (Node.isArrowFunction(inner) || Node.isFunctionExpression(inner))) {
        const body = inner.getBody();
        if (Node.isBlock(body)) {
          const ret = body.getDescendantsOfKind(tsMorph().SyntaxKind.ReturnStatement)[0];
          const re = ret?.getExpression();
          if (re) return unwrapExpr(re, Node);
        } else {
          return unwrapExpr(body, Node);
        }
      }
    }
  }
  return e;
}

function exprName(expr, Node) {
  const e = unwrapExpr(expr, Node);
  if (Node.isCallExpression(e)) {
    const callee = e.getExpression();
    if (Node.isPropertyAccessExpression(callee)) return callee.getName() + "()";
    if (Node.isIdentifier(callee)) return callee.getText() + "()";
    return "json";
  }
  if (Node.isObjectLiteralExpression(e)) {
    const keys = e
      .getProperties()
      .map((p) => (typeof p.getName === "function" ? p.getName() : undefined))
      .filter(Boolean);
    return braceList(keys);
  }
  if (Node.isArrayLiteralExpression(e)) return "[]";
  if (Node.isPropertyAccessExpression(e)) return e.getName();
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isStringLiteral(e)) return "string";
  return "json";
}

function responseName(handler, SyntaxKind, Node) {
  const jsonCalls = [];
  for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "json") continue;
    const args = call.getArguments();
    if (!args[0]) continue;
    const statusArg = args[1];
    const status = statusArg && Node.isNumericLiteral(statusArg) ? Number(statusArg.getLiteralValue()) : undefined;
    jsonCalls.push({ arg: args[0], status });
  }
  if (!jsonCalls.length) return "—";
  const success = jsonCalls.filter((c) => c.status === undefined || c.status < 400);
  const chosen = success.length ? success[success.length - 1] : jsonCalls[jsonCalls.length - 1];
  return exprName(chosen.arg, Node);
}

function parseRouteCall(call, method, prefix, file, SyntaxKind, Node) {
  const sub = literalString(call.getArguments()[0], Node);
  if (sub === undefined) return null;
  const handler = getHandler(call, Node);
  const { openapiPath } = convertPath(joinPaths("/api", prefix, sub));
  return {
    method: method.toUpperCase(),
    path: openapiPath,
    request: handler ? requestName(handler, method, SyntaxKind, Node) : "—",
    response: handler ? responseName(handler, SyntaxKind, Node) : "—",
    description: semanticComment(call, SyntaxKind),
    tag: file.replace(/\.ts$/, ""),
    file: `${SOURCE_PATHSPEC}/${file}`,
    line: call.getStartLineNumber(),
  };
}

function analyzeEndpoints() {
  const { Project, SyntaxKind, Node } = tsMorph();
  const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false } });

  // index.ts → factory→prefix map + inline routes on the aggregate router
  const indexSf = project.addSourceFileAtPath(path.join(ROUTES_DIR, "index.ts"));
  const factoryPrefix = new Map();
  const aggregateVar = findRouterVar(indexSf, SyntaxKind, Node);
  const endpoints = [];

  for (const call of indexSf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) continue;
    const obj = expr.getExpression().getText();
    const member = expr.getName();
    if (member === "route") {
      const args = call.getArguments();
      const prefix = literalString(args[0], Node);
      const factoryArg = args[1];
      if (prefix !== undefined && factoryArg && Node.isCallExpression(factoryArg)) {
        factoryPrefix.set(factoryArg.getExpression().getText(), prefix);
      }
    } else if (obj === aggregateVar && HTTP_METHODS.includes(member)) {
      const r = parseRouteCall(call, member, "", "index.ts", SyntaxKind, Node);
      if (r) {
        r.tag = "internal";
        endpoints.push(r);
      }
    }
  }

  const unmounted = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && f !== "index.ts").sort()) {
    const sf = project.addSourceFileAtPath(path.join(ROUTES_DIR, file));
    for (const fn of sf.getFunctions()) {
      const fname = fn.getName() ?? "";
      if (!fn.isExported() || !/^create.*Route$/.test(fname)) continue;
      const routerVar = findRouterVar(fn, SyntaxKind, Node);
      if (!routerVar) continue;
      const prefix = factoryPrefix.get(fname);
      if (prefix === undefined) {
        unmounted.push(`${file}: ${fname} not mounted in routes/index.ts`);
        continue;
      }
      for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const expr = call.getExpression();
        if (!Node.isPropertyAccessExpression(expr)) continue;
        if (expr.getExpression().getText() !== routerVar) continue;
        if (!HTTP_METHODS.includes(expr.getName())) continue;
        const r = parseRouteCall(call, expr.getName(), prefix, file, SyntaxKind, Node);
        if (r) endpoints.push(r);
      }
    }
  }

  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { endpoints, unmounted };
}

// ===========================================================================
// MARKDOWN render + parse
// ===========================================================================

function cell(s) {
  const v = (s ?? "").toString().replace(/\r?\n/g, " ").replace(/\|/g, "/").trim();
  return v.length ? v : "—";
}

function renderDoc(endpoints, meta) {
  const byTag = new Map();
  for (const e of endpoints) {
    if (!byTag.has(e.tag)) byTag.set(e.tag, []);
    byTag.get(e.tag).push(e);
  }
  const lines = [];
  lines.push("---");
  lines.push(`generated: ${meta.generated}`);
  lines.push(`commit: ${meta.commit}`);
  lines.push(`endpoints: ${endpoints.length}`);
  lines.push(`source: ${SOURCE_PATHSPEC}`);
  lines.push("---");
  lines.push("");
  lines.push("# API Endpoint Catalog");
  lines.push("");
  lines.push("> Auto-generated & maintained by the `endpoint-docs` skill.");
  lines.push("> Regenerate: `node .claude/skills/endpoint-docs/endpoint-docs.mjs update`.");
  lines.push("> Query: `… endpoint-docs.mjs find <q>` · `get <METHOD> <path>` · `usage <path>`.");
  lines.push("");
  lines.push(
    "Columns — **Request**: named type, `{field, …}` inline shape, `json` (untyped body), or `—` (none). " +
      "**Response**: the producing service call `name()`, `{field, …}` literal, or `json`.",
  );
  lines.push("");

  for (const tag of [...byTag.keys()].sort()) {
    const rows = byTag.get(tag).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    lines.push(`## ${tag}`);
    lines.push("");
    lines.push("| Method | Path | Request | Response | Description |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const e of rows) {
      lines.push(`| ${cell(e.method)} | ${cell(e.path)} | ${cell(e.request)} | ${cell(e.response)} | ${cell(e.description)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function parseDoc(text) {
  const fm = {};
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    body = m[2];
  }
  const endpoints = [];
  let tag = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      tag = h[1].trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === "Method" || /^-+$/.test(cells[0])) continue;
    endpoints.push({
      method: cells[0],
      path: cells[1],
      request: cells[2],
      response: cells[3],
      description: cells[4] === "—" ? "" : cells[4],
      tag,
    });
  }
  return { frontmatter: fm, endpoints };
}

function readDoc() {
  if (!fs.existsSync(DOC_PATH)) return null;
  return parseDoc(fs.readFileSync(DOC_PATH, "utf8"));
}

// ===========================================================================
// COMMANDS
// ===========================================================================

function cmdBuild({ quiet } = {}) {
  const { endpoints, unmounted } = analyzeEndpoints();
  const meta = { generated: new Date().toISOString(), commit: headSha() };
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, renderDoc(endpoints, meta) + "\n", "utf8");
  if (!quiet) {
    const tags = new Set(endpoints.map((e) => e.tag)).size;
    console.log(`✓ ${path.relative(REPO_ROOT, DOC_PATH)} — ${endpoints.length} endpoints across ${tags} tags @ ${meta.commit.slice(0, 12)}`);
    if (unmounted.length) {
      console.warn(`⚠ ${unmounted.length} unmounted route factory(ies) (excluded):`);
      for (const u of unmounted) console.warn(`  - ${u}`);
    }
  }
  return endpoints;
}

function key(e) {
  return `${e.method} ${e.path}`;
}

function cmdUpdate() {
  const before = readDoc();
  cmdBuild({ quiet: true });
  // Re-read the written doc so both sides went through identical sanitization —
  // otherwise pipe-escaped descriptions show as false "changed" churn.
  const after = readDoc();
  const oldMap = new Map((before?.endpoints ?? []).map((e) => [key(e), e]));
  const newMap = new Map(after.endpoints.map((e) => [key(e), e]));

  const added = [...newMap.keys()].filter((k) => !oldMap.has(k));
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k));
  const changed = [];
  for (const [k, e] of newMap) {
    const o = oldMap.get(k);
    if (!o) continue;
    const diffs = ["request", "response", "description"].filter((f) => (o[f] || "") !== (e[f] || ""));
    if (diffs.length) changed.push({ key: k, diffs });
  }

  console.log(`✓ ${path.relative(REPO_ROOT, DOC_PATH)} rebuilt @ ${headSha().slice(0, 12)} (${after.endpoints.length} endpoints)`);
  if (!before) {
    console.log("  (no previous catalog — created fresh)");
    return;
  }
  if (!added.length && !removed.length && !changed.length) {
    console.log("  no endpoint changes");
    return;
  }
  for (const k of added) console.log(`  + ${k}`);
  for (const k of removed) console.log(`  - ${k}`);
  for (const c of changed) console.log(`  ~ ${c.key} (${c.diffs.join(", ")})`);
}

function cmdCheck({ json } = {}) {
  const doc = readDoc();
  if (!doc) {
    const out = { stale: true, reason: "no catalog", docPath: path.relative(REPO_ROOT, DOC_PATH) };
    print(out, json, () => console.log("⚠ no catalog — run `endpoint-docs build`"));
    process.exit(1);
  }
  const sha = doc.frontmatter.commit;
  const changed = sha ? changedRouteFiles(sha) : null;
  if (changed === null) {
    const out = { stale: true, reason: sha ? "recorded commit not in history" : "no commit in frontmatter", recordedCommit: sha ?? null };
    print(out, json, () => console.log(`⚠ stale: ${out.reason} — run \`endpoint-docs update\``));
    process.exit(1);
  }
  const stale = changed.length > 0;
  const out = {
    stale,
    recordedCommit: sha,
    head: headSha(),
    changedRouteFiles: changed,
    docPath: path.relative(REPO_ROOT, DOC_PATH),
  };
  print(out, json, () => {
    if (!stale) {
      console.log(`✓ catalog fresh @ ${sha.slice(0, 12)} (no route files changed since)`);
    } else {
      console.log(`⚠ stale: ${changed.length} route file(s) changed since ${sha.slice(0, 12)}:`);
      for (const f of changed) console.log(`  - ${f}`);
      console.log("Run `endpoint-docs update`.");
    }
  });
  process.exit(stale ? 1 : 0);
}

function requireDoc() {
  const doc = readDoc();
  if (!doc) {
    console.error("No catalog found. Run `endpoint-docs build` first.");
    process.exit(2);
  }
  return doc;
}

function cmdList(args) {
  const json = args.includes("--json");
  const tagIdx = args.indexOf("--tag");
  const tag = tagIdx >= 0 ? args[tagIdx + 1] : undefined;
  let eps = requireDoc().endpoints;
  if (tag) eps = eps.filter((e) => e.tag === tag);
  print(eps, json, () => printTable(eps));
}

function cmdFind(args) {
  const json = args.includes("--json");
  const q = args.find((a) => !a.startsWith("--"));
  if (!q) return fail("usage: find <query> [--json]");
  const needle = q.toLowerCase();
  const eps = requireDoc().endpoints.filter((e) =>
    [e.path, e.description, e.request, e.response, e.tag].some((f) => (f || "").toLowerCase().includes(needle)),
  );
  print(eps, json, () => (eps.length ? printTable(eps) : console.log(`no endpoints match "${q}"`)));
}

function normPath(p) {
  let v = p;
  // Recover from MSYS/Git-Bash path mangling (e.g. "C:/.../Git/api/projects").
  const api = v.search(/\/api(\/|$)/);
  if (api > 0) v = v.slice(api);
  v = v.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  if (!v.startsWith("/")) v = "/" + v;
  return v;
}

function cmdGet(args) {
  const json = args.includes("--json");
  const pos = args.filter((a) => !a.startsWith("--"));
  if (pos.length < 2) return fail("usage: get <METHOD> <path> [--json]");
  const method = pos[0].toUpperCase();
  const want = normPath(pos[1]);
  const eps = requireDoc().endpoints.filter((e) => e.method === method && (e.path === want || e.path.endsWith(want)));
  if (!eps.length) return fail(`not found: ${method} ${want}`, 1);
  print(eps.length === 1 ? eps[0] : eps, json, () => {
    for (const e of eps) {
      console.log(`${e.method} ${e.path}   [${e.tag}]`);
      console.log(`  request:  ${e.request}`);
      console.log(`  response: ${e.response}`);
      if (e.description) console.log(`  semantic: ${e.description}`);
    }
  });
}

function usageRegex(p) {
  const norm = normPath(p);
  const parts = norm.split(/\{[A-Za-z0-9_]+\}/);
  return parts.map((s) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")).join("[^/'\"`\\s]+");
}

function cmdUsage(args) {
  const json = args.includes("--json");
  const pos = args.filter((a) => !a.startsWith("--"));
  if (!pos.length) return fail("usage: usage <path> [--json]");
  const rx = usageRegex(pos[0]);
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-nE", rx, "--", ...USAGE_DIRS], { encoding: "utf8", cwd: REPO_ROOT });
  } catch {
    out = ""; // git grep exits non-zero when there are no matches
  }
  const hits = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : null;
    })
    .filter(Boolean);
  print(hits, json, () => {
    if (!hits.length) return console.log(`no usages found for ${pos[0]}`);
    console.log(`${hits.length} usage(s) of ${normPath(pos[0])}:`);
    for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
  });
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function print(data, json, human) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

function printTable(eps) {
  if (!eps.length) return console.log("(none)");
  const w = (k, min) => Math.max(min, ...eps.map((e) => (e[k] || "").length));
  const mw = w("method", 6);
  const pw = Math.min(w("path", 4), 48);
  for (const e of eps) {
    console.log(`${e.method.padEnd(mw)}  ${e.path.padEnd(pw)}  ${e.description || ""}`);
  }
  console.log(`\n${eps.length} endpoint(s)`);
}

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function help() {
  console.log(`endpoint-docs — REST API catalog (${path.relative(REPO_ROOT, DOC_PATH)})

  build                 (re)generate the catalog from route source
  update                rebuild + print a changelog (added/removed/changed)
  check [--json]        is the catalog stale vs HEAD? (exit 1 if stale)
  list [--tag T] [--json]
  find <query> [--json]
  get <METHOD> <path> [--json]
  usage <path> [--json]
`);
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "build": cmdBuild(); break;
  case "update": cmdUpdate(); break;
  case "check": cmdCheck({ json: rest.includes("--json") }); break;
  case "list": cmdList(rest); break;
  case "find": cmdFind(rest); break;
  case "get": cmdGet(rest); break;
  case "usage": cmdUsage(rest); break;
  case "help": case "--help": case "-h": case undefined: help(); break;
  default: fail(`unknown command: ${cmd}\nRun \`endpoint-docs help\`.`);
}
