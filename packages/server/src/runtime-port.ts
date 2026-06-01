const DEFAULT_SERVER_PORT = 3001;

function parsePort(value: string | undefined): number | null {
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function resolveRuntimeServerPort(env: NodeJS.ProcessEnv = process.env): number {
  return (
    parsePort(env.KANBAN_WORKTREE_SERVER_PORT) ??
    parsePort(env.KANBAN_SERVER_PORT) ??
    parsePort(env.SERVER_PORT) ??
    parsePort(env.PORT) ??
    DEFAULT_SERVER_PORT
  );
}
