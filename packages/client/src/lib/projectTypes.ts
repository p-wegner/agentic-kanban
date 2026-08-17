/**
 * Client-side project DTO shapes (#610).
 *
 * `Project` was declared THREE times — `routes/BoardPage.tsx`, `components/Layout.tsx`,
 * `components/WorkspaceCard.tsx` — and hooks/lib modules imported it UPWARD from the leaf
 * that happened to render it (`hooks/useBoardDataQueries.ts` → `routes/BoardPage.tsx`).
 * A container page acting as the DTO module is what makes those upward edges look normal.
 *
 * The three were NOT the same type, which is the reason this file declares two:
 * BoardPage's and WorkspaceCard's are the same full project record, but Layout's is a
 * loose list-item shape — every field optional, plus `color` and `activeWorkspaceCount`,
 * and without `remoteUrl`/`setup*`/`symlink*`. Collapsing them into one would have
 * tightened Layout's contract and rejected the partial objects its callers pass.
 */

/** The full project record, as the board and workspace surfaces consume it. */
export interface Project {
  id: string;
  name: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript?: string | null;
  setupEnabled?: boolean;
  setupBlocking?: boolean;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | null;
  archivedAt?: string | null;
}

/**
 * The project-switcher / chrome shape: deliberately looser than {@link Project}.
 * Callers hand it partially-populated rows, and it carries two presentation-only fields
 * (`color`, `activeWorkspaceCount`) the full record has no reason to know about.
 */
export interface ProjectListItem {
  id: string;
  name: string;
  color?: string | null;
  repoName?: string | null;
  repoPath?: string | null;
  defaultBranch?: string | null;
  archivedAt?: string | null;
  activeWorkspaceCount?: number;
}
