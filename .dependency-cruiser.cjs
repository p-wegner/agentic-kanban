// Architecture boundary rules for the agentic-kanban monorepo.
//
// WHY THIS EXISTS
// The layering (routes -> services -> repositories -> db; shared is an acyclic
// leaf) was previously documented only in CLAUDE.md prose. `tsc --noEmit` was
// the ONLY static gate, so every boundary eroded silently. This config makes the
// rules machine-checkable.
//
// SEVERITY POLICY (baseline-aware so it lands green and never blocks work):
//   - error  -> edges that are ALREADY clean today (0 violations). Locks them in:
//               any NEW violation fails `pnpm lint:arch` / `pnpm check`.
//   - warn   -> known pre-existing debt (quantified backlogs). Non-blocking.
//               As each slice is migrated, TIGHTEN the rule (warn -> error, or
//               narrow its scope with a pathNot allow-list) so progress is locked
//               in and cannot regress.
//
// Run:  pnpm lint:arch        (exit code = number of ERROR-severity violations)
//       pnpm lint:arch:report (full HTML/text report incl. warns)
//
// Tighten a warn rule the moment its backlog hits zero. Backlog counts as of the
// commit that introduced this file are noted inline.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ───────────────────────── ERROR: clean edges, locked in ─────────────────────────
    {
      name: "no-circular",
      comment:
        "No RUNTIME circular dependencies in application code (type-only imports are erased " +
        "and ignored, see options.tsPreCompilationDeps=false). Enforces the documented " +
        "factory-fn / lazy-getter discipline. The Drizzle schema dir is excluded: table " +
        "relations() are mutually-referential by design (sessions<->workspaces, issues<->tags) " +
        "and those value-level cycles are inherent to the ORM, not a layering smell. " +
        "Backlog (outside schema): 0.",
      severity: "error",
      from: { pathNot: "^packages/shared/src/schema/" },
      to: { circular: true },
    },
    {
      name: "shared-is-a-leaf",
      comment:
        "packages/shared must never import from server or mcp-server. shared is the " +
        "single-source-of-truth leaf both depend on. Backlog: 0.",
      severity: "error",
      from: { path: "^packages/shared/src" },
      to: { path: "^packages/(server|mcp-server)/" },
    },
    {
      name: "mcp-no-server-internals",
      comment:
        "mcp-server must not reach into server package internals; it shares logic via " +
        "@agentic-kanban/shared (e.g. git-service re-export). Backlog: 0.",
      severity: "error",
      from: { path: "^packages/mcp-server/src" },
      to: { path: "^packages/server/src" },
    },
    {
      name: "services-not-up-to-routes",
      comment:
        "Application layer (services) must not depend on the transport layer (routes). " +
        "Dependencies point down. Backlog: 0.",
      severity: "error",
      from: { path: "^packages/server/src/services/" },
      to: { path: "^packages/server/src/routes/" },
    },
    {
      name: "repositories-not-up-to-routes",
      comment:
        "Persistence layer (repositories) must not depend on the transport layer " +
        "(routes). Backlog: 0.",
      severity: "error",
      from: { path: "^packages/server/src/repositories/" },
      to: { path: "^packages/server/src/routes/" },
    },
    {
      name: "client-no-drizzle-or-schema",
      comment:
        "The client bundle must never import the ORM or the Drizzle schema as a VALUE. " +
        "The wire contract is the hand-authored DTOs in @agentic-kanban/shared/types; " +
        "Drizzle rows ($inferSelect) and drizzle-orm operators stay server-side. A value " +
        "import of either pulls drizzle into the browser bundle AND couples the client to " +
        "the persistence layer. Type-only imports are erased (tsPreCompilationDeps:false), " +
        "so importing a schema TYPE does not trip this — only a runtime value import does. " +
        "Complements the #791 barrel-client-safety test (node-builtins); this guards the " +
        "wire-DTO boundary, which was convention-only before. Lands green today. Backlog: 0.",
      severity: "error",
      from: { path: "^packages/client/src" },
      to: { path: ["drizzle-orm", "@agentic-kanban/shared/schema", "^packages/shared/src/schema"] },
    },
    // ───────────────────────── WARN: known debt backlogs ─────────────────────────
    {
      name: "routes-not-down-to-persistence",
      comment:
        "Transport (routes) must not run persistence: no VALUE import of db/index, " +
        "drizzle-orm, or @agentic-kanban/shared/schema. Type-only imports are erased " +
        "(tsPreCompilationDeps:false) so a `import type { Database }` is fine. Originally a " +
        "26-file warn backlog; drained to ERROR for every clean route. The `pathNot` allow-list " +
        "is the SHRINKING remaining backlog (analytics-heavy routes that need thin aggregation " +
        "services). Drain one -> delete its line here AND in the companion warn rule. When the " +
        "list is empty, remove both the pathNot and the warn rule — the gate is then total.",
      severity: "error",
      from: {
        path: "^packages/server/src/routes/",
        pathNot: [
          "^packages/server/src/routes/butler\\.ts$",
          "^packages/server/src/routes/digest\\.ts$",
          "^packages/server/src/routes/focus\\.ts$",
          "^packages/server/src/routes/insights\\.ts$",
          "^packages/server/src/routes/issues\\.ts$",
          "^packages/server/src/routes/projects\\.ts$",
          "^packages/server/src/routes/workspaces\\.ts$",
        ],
      },
      to: {
        path: [
          "^packages/server/src/db/index",
          "/db/index\\.js$",
          "drizzle-orm",
          "@agentic-kanban/shared/schema",
        ],
      },
    },
    {
      name: "routes-not-down-to-persistence-backlog",
      comment:
        "WARN tracker for the routes still holding inline persistence (mirrors the error rule's " +
        "pathNot allow-list). Keeps the remaining drain backlog visible in lint:arch:report. " +
        "When a route is drained, remove its line from BOTH this rule and the error rule's pathNot.",
      severity: "warn",
      from: {
        path: [
          "^packages/server/src/routes/butler\\.ts$",
          "^packages/server/src/routes/digest\\.ts$",
          "^packages/server/src/routes/focus\\.ts$",
          "^packages/server/src/routes/insights\\.ts$",
          "^packages/server/src/routes/issues\\.ts$",
          "^packages/server/src/routes/projects\\.ts$",
          "^packages/server/src/routes/workspaces\\.ts$",
        ],
      },
      to: {
        path: [
          "^packages/server/src/db/index",
          "/db/index\\.js$",
          "drizzle-orm",
          "@agentic-kanban/shared/schema",
        ],
      },
    },
    {
      name: "repositories-not-up-to-services",
      comment:
        "BACKLOG (1: session.repository.ts imports sessionOutputPath from agent.service). " +
        "Persistence must not depend on application. Fix by relocating the path helper to a " +
        "lib/constants module, then tighten to error.",
      severity: "warn",
      from: { path: "^packages/server/src/repositories/" },
      to: { path: "^packages/server/src/services/" },
    },
    {
      name: "services-bypass-repositories",
      comment:
        "BACKLOG (76 services import drizzle-orm directly): the application layer runs raw " +
        "persistence instead of going through a repository, so there is no seam to test/swap " +
        "the data layer. Drain incrementally; not a hard gate yet.",
      severity: "info",
      from: { path: "^packages/server/src/services/" },
      to: { path: "drizzle-orm" },
    },
  ],

  options: {
    // Resolve the monorepo's NodeNext-style `.js`-extension imports + package
    // `exports` (the "development" condition maps @agentic-kanban/shared -> src).
    tsConfig: { fileName: ".dependency-cruiser.tsconfig.json" },
    // Ignore type-only imports: they are erased at compile time, carry no runtime
    // edge, and the only circular dependency in the repo is type-only. This is what
    // lets `no-circular` land at error severity today.
    tsPreCompilationDeps: false,
    // doNotFollow (NOT exclude) for node_modules: keep third-party modules as leaf
    // nodes in the graph so rules can match edges TO them (e.g. routes/services ->
    // drizzle-orm). `exclude` would delete the node and silently match nothing.
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "\\.worktrees/",
        "/dist/",
        "/__tests__/",
        "\\.test\\.(ts|tsx)$",
        "/drizzle/",
        "\\.d\\.ts$",
      ],
    },
    enhancedResolveOptions: {
      // Prefer the package's "development" export (src) so cross-package edges resolve
      // to TypeScript source, matching how `pnpm dev` runs.
      conditionNames: ["development", "import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
