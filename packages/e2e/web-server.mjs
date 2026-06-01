import { spawn } from "child_process";

const [, , envKey, envValue, command, ...args] = process.argv;

if (!envKey || envValue === undefined || !command) {
  console.error("Usage: node packages/e2e/web-server.mjs <envKey> <envValue> <command> [...args]");
  process.exit(1);
}

const executable = process.platform === "win32" ? "cmd.exe" : command;
const spawnArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...args] : args;

const child = spawn(executable, spawnArgs, {
  env: { ...process.env, [envKey]: envValue },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
