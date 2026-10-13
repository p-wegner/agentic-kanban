// Types for promote-merge-back.mjs (#1436), hand-written like promote-plan.d.mts.
export interface MergeBackDeps {
  rcBranch: string;
  baseBranch: string;
  tag: string;
  git: (args: string[]) => { code: number; stdout: string; stderr: string };
  requestWorkspace: () => Promise<{ issueNumber?: number; workspaceId?: string; created?: boolean } | null>;
  reprobe: () => Promise<boolean>;
  markAttention: (reason: string) => Promise<void>;
  log: (line: string) => void;
}
export type MergeBackResult =
  | { outcome: "nothing" }
  | { outcome: "merged"; count: number; sha: string }
  | { outcome: "workspace"; count: number }
  | { outcome: "failed"; count: number; reason: string };
export function mergeBackRc(d: MergeBackDeps): Promise<MergeBackResult>;
