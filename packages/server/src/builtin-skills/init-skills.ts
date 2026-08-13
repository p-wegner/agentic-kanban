// Init skills — one-time project-init steps (#462) — live apart from
// `builtin-skills.ts` because this is the group most likely to grow (each new
// onboarding step adds one entry here), and `builtin-skills.ts` sits at the
// god-module line-count ceiling with no room to keep absorbing them.
export const BUILTIN_INIT_SKILLS = [
  {
    name: "project-context-init",
    description: "One-time project-init step: run the coding agent's own init flow to produce/refresh CLAUDE.md/AGENTS.md for this repo",
    isInit: true,
    prompt: `You are running a one-time project-init step against a freshly imported codebase. Your output is a durable artifact — an up-to-date \`CLAUDE.md\` (or \`AGENTS.md\`) — not a code change.

## Process

1. **Read the tree.** Walk the repo structure: top-level directories, package manifests (\`package.json\`, \`pyproject.toml\`, \`go.mod\`, ...), lockfiles, and any existing \`CLAUDE.md\`/\`AGENTS.md\`/\`README.md\`.
2. **Find the build/test/dev commands.** Look in package scripts, Makefiles, CI config (\`.github/workflows\`), and READMEs. Verify a command actually exists before writing it down — do not guess.
3. **Find the conventions.** Note the language(s)/framework(s), monorepo layout if any, test framework, linter/formatter config, and any hard constraints already documented (safety rules, don't-touch files, required workflows).
4. **Write the file.** If \`CLAUDE.md\` (or \`AGENTS.md\`) already exists, refresh it — preserve sections that are still accurate, correct ones that have drifted, and add missing build/test/convention info. If neither exists, create \`CLAUDE.md\` at the repo root with: what the project is, key commands, architecture/conventions notes, and any hard constraints.
5. **Commit** the file with a clear message (e.g. \`docs: init project context\`).

## Rules
- Do not invent commands or conventions you have not verified against the actual repo.
- Keep it concise and information-dense — this file is read by every future agent session, so verbosity has a recurring cost.
- Do not make unrelated code changes.`,
    model: null,
  },
  {
    name: "api-surface-doc",
    description: "One-time project-init step: enumerate the project's externally reachable surface (HTTP routes, CLI commands, exported library API) into docs/api-surface.md",
    isInit: true,
    prompt: `You are running a one-time project-init step against a freshly imported codebase. Your output is a durable artifact — \`docs/api-surface.md\` — not a code change.

## Goal
Enumerate everything the project exposes to the outside world so a future agent (or human) can find the API surface without re-deriving it from source.

## What counts as "surface"
- **HTTP routes** — every method+path registered by the web framework, with a one-line purpose.
- **CLI commands** — every subcommand/flag exposed by a CLI entry point.
- **Exported library API** — for a package meant to be imported elsewhere, its public exports (functions, classes, types).
- **MCP tools / other RPC-style entry points**, if present.

## Process
1. Find every entry point: route registration files, CLI argument parsers, package \`main\`/\`exports\` fields, MCP tool registrations.
2. For each, record: name/path, method or invocation form, and a one-line purpose inferred from its implementation (not just its name).
3. Group by kind (HTTP / CLI / library exports / other) and, within a kind, by module or feature area.
4. Write \`docs/api-surface.md\` with a table per group.
5. **Commit** the file with a clear message (e.g. \`docs: document api surface\`).

## Rules
- Only list surface you actually found in the code — do not guess or extrapolate from naming conventions.
- If the project has no externally reachable surface of a given kind (e.g. pure internal library), state that explicitly rather than omitting the section.
- Do not make unrelated code changes.`,
    model: null,
  },
] as const;
