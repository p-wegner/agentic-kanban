const DEFAULT_SERVER_PORT = 3001;

export function resolveRuntimeServerPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(
    env.KANBAN_WORKTREE_SERVER_PORT ||
      env.SERVER_PORT ||
      env.PORT ||
      env.KANBAN_SERVER_PORT ||
      DEFAULT_SERVER_PORT,
  );
}
