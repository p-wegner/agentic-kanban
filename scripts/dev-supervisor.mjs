export function classifyProcessExit(code, signal) {
  if (signal === "SIGINT" || signal === "SIGTERM") return "clean";
  if (code === 0) return "clean";

  // The server child is `tsx watch src/index.ts`. tsx handles hot reloads inside
  // that watcher process, so this supervisor should only see an exit when the
  // watcher itself stopped. Keep code=1 fatal to avoid retry loops on startup
  // failures such as EADDRINUSE, migration errors, or syntax/load failures.
  if (code === 1) return "fatal";

  return "retry";
}
