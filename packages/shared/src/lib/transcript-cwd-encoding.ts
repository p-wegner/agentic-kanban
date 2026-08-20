/**
 * Claude's project-directory name encoding: every character that isn't
 * alphanumeric or `-` becomes `-`. Verified against real `~/.claude/projects/*`
 * directory names on disk, including a dotted worktree path — the `.` in
 * `.worktrees` maps to `-` just like `:`, `\`, and `/` do (#159; the previous
 * `[:\\/]`-only regex missed it, so containerized-builder transcripts for a
 * dotted worktree path were written to a directory session-inspector and
 * Claude-native tooling never look in).
 */
export function encodeTranscriptCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}
