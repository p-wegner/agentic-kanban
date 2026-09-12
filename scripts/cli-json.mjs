// Machine-readable entry point for the CLI (#1109).
//
// `pnpm cli -- issue get <N> --json` is unparseable: ANY `pnpm run <script>` prints
// pnpm's own "> agentic-kanban@ cli ... > <the real command>" banner to stdout ahead of
// the script's own output, and that banner is emitted unconditionally for a *named*
// script — passing flags inside the script body cannot suppress it, only invoking pnpm
// itself with `--silent` can (`pnpm --silent cli -- ...`), and that is easy to forget.
//
// This script sidesteps the problem instead of relying on a caller remembering a flag:
// it is invoked directly with `node` (never `pnpm run <name>`), so pnpm's script-run
// banner never fires. It then shells out to the *same* `pnpm --filter agentic-kanban
// exec ...` command `cli` uses — `pnpm exec` (unlike `pnpm run`) prints nothing of its
// own — with stdio inherited, so stdout carries only the CLI's own output.
//
// Usage: node scripts/cli-json.mjs -- issue get <N> --json
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Strips a bare `--` argv separator — `node cli-json.mjs -- issue get 1 --json` and
 * `node cli-json.mjs issue get 1 --json` must reach the CLI identically. */
export function buildCliArgs(argv) {
  return argv.filter((a) => a !== "--");
}

export function buildPnpmExecArgs(cliArgs) {
  return ["--filter", "agentic-kanban", "exec", "node", "--disable-warning=DEP0205", "--import", "tsx", "src/cli/index.ts", ...cliArgs];
}

function main() {
  const cliArgs = buildCliArgs(process.argv.slice(2));
  const res = spawnSyncPnpm(buildPnpmExecArgs(cliArgs), { cwd: repoRoot, stdio: "inherit" });
  process.exit(res.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith("cli-json.mjs")) {
  main();
}
