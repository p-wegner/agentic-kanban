import { spawn } from "child_process";

/**
 * Run a command with extra environment applied — the E2E stack's dev servers, and the
 * `test:system` lane, which needs KANBAN_E2E_SYSTEM=1 in an npm script on a platform
 * with no `VAR=value cmd` prefix syntax.
 *
 * Usage: node web-server.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [...args]
 *
 * #645: this took exactly ONE `<envKey> <envValue>` pair, which is why the E2E server
 * could be given a port but never its own `AGENTIC_KANBAN_DIR` — so every run registered
 * a project into, and switched the active project of, whatever board owned the default
 * DB. Any number of assignments is accepted now, separated from the command by `--`.
 * The old two-positional form is still understood so a stale invocation does not
 * silently launch a server with no env at all.
 */
const argv = process.argv.slice(2);

const env = {};
let command;
let args = [];

const sep = argv.indexOf("--");
if (sep !== -1) {
  for (const assignment of argv.slice(0, sep)) {
    const eq = assignment.indexOf("=");
    if (eq <= 0) {
      console.error(`web-server.mjs: not a KEY=VALUE assignment: ${assignment}`);
      process.exit(1);
    }
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1);
  }
  [command, ...args] = argv.slice(sep + 1);
} else {
  // Legacy form: <envKey> <envValue> <command> [...args]
  const [envKey, envValue, cmd, ...rest] = argv;
  if (!envKey || envValue === undefined || !cmd) {
    console.error("Usage: node packages/e2e/web-server.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [...args]");
    process.exit(1);
  }
  env[envKey] = envValue;
  command = cmd;
  args = rest;
}

if (!command) {
  console.error("Usage: node packages/e2e/web-server.mjs KEY=VALUE [KEY=VALUE ...] -- <command> [...args]");
  process.exit(1);
}

const executable = process.platform === "win32" ? "cmd.exe" : command;
const spawnArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;

const child = spawn(executable, spawnArgs, {
  env: { ...process.env, ...env },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
