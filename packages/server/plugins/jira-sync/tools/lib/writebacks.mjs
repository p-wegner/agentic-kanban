// Applies `writebacks.json` (board issue id -> freshly created Jira key) back onto
// the board issue as `externalKey`/`externalUrl`, so a following pull recognises the
// issue instead of importing the Jira key as a second board issue (#1623). An entry
// leaves the file only once the board accepted it; until then pull treats the key as
// pending and refuses to create a board issue for it.

export function externalUrlFor(siteUrl, key) {
  return siteUrl ? `${siteUrl.replace(/\/+$/, "")}/browse/${key}` : null;
}

/**
 * @returns {Promise<{ keys: Record<string,string>, applied: string[], failed: Array<{boardIssueId:string,key:string,reason:string}> }>}
 *   `keys` is what must remain in writebacks.json.
 */
export async function applyWritebacks(boardClient, writebacks, { siteUrl, dryRun = false } = {}) {
  const keys = { ...writebacks.keys };
  const applied = [];
  const failed = [];
  if (dryRun) return { keys, applied, failed };
  for (const [boardIssueId, key] of Object.entries(writebacks.keys)) {
    try {
      await boardClient.updateIssue(boardIssueId, { externalKey: key, externalUrl: externalUrlFor(siteUrl, key) });
      delete keys[boardIssueId];
      applied.push(boardIssueId);
    } catch (err) {
      failed.push({ boardIssueId, key, reason: err.message });
    }
  }
  return { keys, applied, failed };
}
