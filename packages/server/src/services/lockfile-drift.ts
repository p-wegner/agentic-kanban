/**
 * #1483 — a diff that changes `pnpm-lock.yaml` while no `package.json` / `pnpm-workspace.yaml` changes
 * is always an environment artifact (a worker's different pnpm re-resolved the lockfile; train 44 lost
 * its security overrides that way). Pure: takes the changed file names, returns the refusal or null.
 */
const isLockfile = (file: string): boolean => /(^|\/)pnpm-lock\.yaml$/.test(file);
const isManifest = (file: string): boolean => /(^|\/)(package\.json|pnpm-workspace\.yaml)$/.test(file);

export function describeLockfileOnlyDrift(changedFiles: readonly string[]): string | null {
  const files = changedFiles.map((f) => f.replace(/\\/g, "/"));
  if (!files.some(isLockfile) || files.some(isManifest)) return null;
  return (
    "pre-merge gate refused: pnpm-lock.yaml changed but no package.json or pnpm-workspace.yaml did (lockfile-only drift). " +
    "That is an environment artifact (an install under a different pnpm than the repo's packageManager), and it can silently drop the " +
    "security overrides. Restore it with `git checkout <base> -- pnpm-lock.yaml` and commit (#1483)."
  );
}
