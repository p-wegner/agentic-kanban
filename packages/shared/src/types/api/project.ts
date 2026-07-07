// Project resource wire-contract types (pure DTOs). See ../api.ts barrel.

export interface CreateProjectRequest {
  name?: string;
  repoPath: string;
  description?: string;
  color?: string;
  exportSkillsOnRegistration?: boolean;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  color?: string;
  defaultBranch?: string | null;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
  teardownScript?: string | null;
  autoRetryFlakes?: boolean;
  maxRetries?: number;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | string[] | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript: string | null;
  setupBlocking: boolean;
  setupEnabled: boolean;
  teardownScript: string | null;
  autoRetryFlakes: boolean | null;
  maxRetries: number | null;
  symlinkEnabled: boolean;
  symlinkDirs: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStatsResponse {
  commitCount: number;
  recentCommits: { hash: string; message: string; date: string }[];
  issueCounts: Record<string, number>;
  detectedBranch: string | null;
  codeMetrics: {
    generatedAt: string;
    productionLoc: number;
    testLoc: number;
    totalLoc: number;
    testRatio: number;
    productionFiles: number;
    testFiles: number;
    sourceFilesScanned: number;
  };
  history: {
    weeks: Array<{
      week: string;
      commits: number;
      insertions: number;
      deletions: number;
      net: number;
      productionNet: number;
      testNet: number;
    }>;
    contributorCount: number;
    topContributors: Array<{ name: string; commits: number }>;
  };
  hotspots: Array<{
    path: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

/**
 * Durable per-project stack descriptor — the ONE source of stack facts the feedback
 * harness (hooks / verify / dev-server / build-clean) reads instead of re-deriving them
 * ad-hoc per call. Detected at registration from marker files (+ optional LLM fallback)
 * and persisted to the `project_stack_profile_<projectId>` preference. Every field is
 * nullable so a partially-detected stack still produces a usable profile.
 */
export interface StackProfile {
  /** Coarse stack family, e.g. "node", "rust", "go", "python", "java", "ruby", "elixir". */
  stack: string | null;
  /** Package / dependency manager, e.g. "pnpm", "npm", "yarn", "bun", "cargo", "go", "pip", "poetry", "gradle", "maven". */
  packageManager: string | null;
  /** True when this is a monorepo with multiple workspaces/packages. */
  isMonorepo: boolean;
  /** Workspace globs (e.g. ["packages/*"]) for a monorepo; empty otherwise. */
  workspaces: string[];
  /** Command that installs dependencies (e.g. "pnpm install"). */
  installCommand: string | null;
  /** Full build command. */
  buildCommand: string | null;
  /** Full test command. */
  testCommand: string | null;
  /** Fast/affected-only test command for quick local feedback. */
  quickTestCommand: string | null;
  /** Lint command, if the project has one. */
  lintCommand: string | null;
  /** Typecheck command (e.g. "tsc --noEmit"), if applicable. */
  typecheckCommand: string | null;
  /** Dev-server command (e.g. "pnpm dev"), if the project runs a server. */
  devCommand: string | null;
  /** Whether this project serves a web UI / HTTP endpoint. */
  isWeb: boolean;
  /** Dev-server health-check URL, when known. */
  devHealthUrl: string | null;
  /** Dev-server port, when known. */
  devPort: number | null;
  /** Directory tests live in (e.g. "tests", "src/__tests__"). */
  testDir: string | null;
  /** Test runner, e.g. "vitest", "jest", "pytest", "cargo", "go test", "gradle". */
  testRunner: string | null;
  /** How the profile was produced: "detected" (rule-based), "llm" (AI fallback used), or "manual" (user override). */
  source: "detected" | "llm" | "manual";
  /** Marker files that drove detection (e.g. ["package.json", "pnpm-lock.yaml"]). */
  detectedMarkers: string[];
  /** ISO timestamp when the profile was last computed/saved. */
  updatedAt: string;
}

export interface StackProfileResponse {
  projectId: string;
  /** Null when the project has no persisted profile yet. */
  profile: StackProfile | null;
}

export type ProjectScriptLastRunStatus = "running" | "success" | "failed" | "error";
export type ProjectScriptCwdMode = "project" | "custom";

export interface ProjectScriptShortcutResponse {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  command: string;
  cwdMode: ProjectScriptCwdMode;
  workingDir: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastRun?: {
    status: ProjectScriptLastRunStatus;
    startedAt: string;
    endedAt: string | null;
    exitCode: number | null;
  } | null;
}

export interface CreateProjectScriptShortcutRequest {
  name: string;
  command: string;
  description?: string | null;
  cwdMode?: ProjectScriptCwdMode;
  workingDir?: string | null;
}

export interface UpdateProjectScriptShortcutRequest {
  name?: string;
  command?: string;
  description?: string | null;
  cwdMode?: ProjectScriptCwdMode;
  workingDir?: string | null;
  sortOrder?: number;
}
