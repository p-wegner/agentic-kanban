/** Both callers of verify_script spend the same test and typecheck worker budget. */
export function buildVerifyResourceEnv(workers: number): Record<string, string> {
  return {
    KANBAN_TEST_MAX_WORKERS: String(workers),
    KANBAN_TYPECHECK_WORKERS: String(Math.min(workers, 2)),
  };
}
