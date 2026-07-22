// Project resource wire-contract types (pure DTOs). See ../api.ts barrel.

import type { ServiceStackConfig } from "../service-stack.js";

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
  /** Declared per-workspace Docker Compose service stack. null/"" clears it. */
  servicesConfig?: ServiceStackConfig | string | null;
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
  /** Declared per-workspace Docker Compose service stack (parsed), or null when none. */
  servicesConfig: ServiceStackConfig | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * An ADDITIONAL repo of a multi-repo project (full-peers model). The leading repo
 * stays on ProjectResponse.repoPath; single-repo projects return an empty list.
 */
export interface ProjectRepoResponse {
  id: string;
  projectId: string;
  path: string;
  name: string | null;
  defaultBranch: string | null;
  /** Per-repo setup/install command run in this repo's worktree at workspace creation (#71). */
  setupScript: string | null;
  /** Per-repo compose file (relative to the repo) whose services join the workspace stack (#71). */
  composeFile: string | null;
  createdAt: string;
}

export interface AddProjectRepoRequest {
  /** Local path to an existing git repo. Exactly one of path/cloneUrl. */
  path?: string;
  /** Git URL to clone into the server's repos root. Exactly one of path/cloneUrl. */
  cloneUrl?: string;
  name?: string;
  /** Per-repo setup/install command (#71). */
  setupScript?: string | null;
  /** Per-repo compose file, relative to the repo root (#71). */
  composeFile?: string | null;
}

/** PATCH body for updating a registered repo's per-repo config (#71, name added #90). */
export interface UpdateProjectRepoRequest {
  /** Display name (used for compose-repo lookup + diff labels). Non-empty, unique among the project's repos. */
  name?: string;
  setupScript?: string | null;
  composeFile?: string | null;
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

/** Where each field of a resolved {@link DevServerPlan} came from, for honest UI provenance. */
export interface DevServerPlanSource {
  command: "pref" | "profile" | "none";
  healthUrl: "pref" | "profile" | "worktree-port" | "none";
  port: "pref" | "profile" | "worktree-port" | "none";
}

/**
 * A fully-resolved plan for booting + health-checking a project's dev server, derived
 * (in precedence order) from per-project `dev_command`/`health_url` overrides, the
 * persisted stack profile, and — ONLY for the board's own checkout — this app's
 * worktree-port convention (3001+N/5173+N). The `source` fields tell the UI how
 * trustworthy each value is, so the diagnostics tab never presents a fabricated port
 * for a project (e.g. a docker-compose / multi-repo app) whose real ports it can't know.
 */
export interface DevServerPlan {
  /** Shell command that starts the dev server (e.g. "pnpm dev", "uvicorn app:app"). */
  command: string;
  /** URL to poll to confirm the server is up, or null when it isn't a web project / is unknown. */
  healthUrl: string | null;
  /** TCP port the server binds, or null when it can't be known for this project. */
  port: number | null;
  /** Whether this project serves an HTTP endpoint at all. */
  isWeb: boolean;
  /** Provenance of each field. */
  source: DevServerPlanSource;
}

export interface WorkspaceDevServerPlanResponse {
  workspaceId: string;
  /** True when this workspace belongs to the board's own checkout (agentic-kanban). */
  isSelfProject: boolean;
  /** Null when the project has no bootable dev-server command configured/detected. */
  plan: DevServerPlan | null;
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
