// A killed `pack-worker` leaves packages/server/package.json stamped `"version": "x-dev.<sha>"`
// (#1404). The stamp is recognised EXACTLY: the only changed line is the version, going from a
// plain version to the same version plus `-dev.<hex>`. Anything else is not ours to touch.
import { gitExecSyncResult } from "./git-exec.mjs";

export const PACK_STAMP_PATH = "packages/server/package.json";

/** True when `diffText` (a `git diff -U0` of the file) is only a `-dev.<sha>` version stamp. */
export function isPackStampDiff(diffText) {
  const lines = diffText.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
  if (lines.length !== 2) return false;
  const removed = /^-\s*"version":\s*"([^"]+)",?\s*$/.exec(lines[0]);
  const added = /^\+\s*"version":\s*"([^"]+)",?\s*$/.exec(lines[1]);
  if (!removed || !added) return false;
  const base = removed[1];
  if (/-dev\./.test(base)) return false;
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-dev\\.[0-9a-z]+$`).test(added[1]);
}

/** Restores a leftover stamp in `cwd`'s checkout. Returns true when it did. */
export function restorePackStamp(cwd) {
  const diff = gitExecSyncResult(["diff", "-U0", "--", PACK_STAMP_PATH], { cwd });
  if (diff.code !== 0 || !diff.stdout || !isPackStampDiff(diff.stdout)) return false;
  return gitExecSyncResult(["checkout", "--", PACK_STAMP_PATH], { cwd }).code === 0;
}
