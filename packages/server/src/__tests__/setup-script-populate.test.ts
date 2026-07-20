import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { StackProfile } from "@agentic-kanban/shared";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createTestDb } from "./helpers/test-db.js";
import {
  deriveSetupScriptFromProfile,
  populateSetupScript,
} from "../services/stack-profile.service.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kanban-setup-pop-"));
}

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: "node", packageManager: "pnpm", isMonorepo: false, workspaces: [],
    installCommand: "pnpm install", buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Insert a bare project row so populateSetupScript has a target to update. */
async function seedProject(db: ReturnType<typeof createTestDb>["db"], setupScript: string | null = null): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id, name: "p", repoPath: "/x", repoName: "p", setupScript, createdAt: now, updatedAt: now,
  });
  return id;
}

describe("deriveSetupScriptFromProfile", () => {
  it("uses the profile's installCommand verbatim", () => {
    const p = profile({ installCommand: "pnpm install -r", isMonorepo: true });
    expect(deriveSetupScriptFromProfile(p, "/nope")).toBe("pnpm install -r");
  });

  it("falls back to marker rules (pnpm monorepo) when there is no profile", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
      expect(deriveSetupScriptFromProfile(null, dir)).toBe("pnpm install -r");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to marker rules (cargo) when profile has no installCommand", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "Cargo.toml"), "[workspace]\nmembers = [\"a\"]\n");
      const p = profile({ stack: null, packageManager: null, installCommand: null });
      expect(deriveSetupScriptFromProfile(p, dir)).toBe("cargo fetch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // #120: the marker fallback used to emit `pip install -e .` for a uv project, which
  // never populates the project-local .venv the verify gate's `uv run pytest` needs.
  it("falls back to uv sync for a uv repo (pyproject.toml + uv.lock)", async () => {
    const dir = await tmp();
    try {
      await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
      await writeFile(join(dir, "uv.lock"), "version = 1\n");
      expect(deriveSetupScriptFromProfile(null, dir)).toBe("uv sync");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty string when nothing can be derived", async () => {
    const dir = await tmp();
    try {
      expect(deriveSetupScriptFromProfile(null, dir)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("populateSetupScript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the monorepo-aware install to projects.setup_script", async () => {
    const { db } = createTestDb();
    const id = await seedProject(db);
    const p = profile({ installCommand: "pnpm install -r", isMonorepo: true });
    const written = await populateSetupScript(id, dir, db, p);
    expect(written).toBe("pnpm install -r");
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBe("pnpm install -r");
  });

  it("no-ops safely (writes nothing) when detection is empty", async () => {
    const { db } = createTestDb();
    const id = await seedProject(db);
    const written = await populateSetupScript(id, dir, db, profile({ installCommand: null }));
    expect(written).toBeNull();
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBeNull();
  });

  it("does not clobber an existing setup script", async () => {
    const { db } = createTestDb();
    const id = await seedProject(db, "make bootstrap");
    const written = await populateSetupScript(id, dir, db, profile({ installCommand: "pnpm install -r" }));
    expect(written).toBe("make bootstrap");
    const [row] = await db.select({ s: projects.setupScript }).from(projects).where(eq(projects.id, id));
    expect(row.s).toBe("make bootstrap");
  });
});
