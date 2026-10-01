import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { createPluginService, stopAllPluginViewsAsync } from "../services/plugin.service.js";
import { decryptSecretMap, encryptSecretMap, loadOrCreateMasterKey } from "../services/plugin-secret-store.js";
import type { Database } from "../db/index.js";

/**
 * #1275: board-held, encrypted sync secrets — the AES-GCM envelope, the write-only settings
 * surface, and injection into `bootstrap` (Test connection) without any host env var.
 */

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const TOKEN = "tok-1275-very-secret";
const SECRET_NAME = "SYNC_TOKEN_TEST_1275";

const MANIFEST = {
  id: "secret-sync-test",
  name: "Secret Sync Test",
  version: "0.1.0",
  scripts: [{ name: "bootstrap", label: "Bootstrap", command: "node bootstrap.mjs", cwd: "plugin" }],
  scaffold: { profileTemplate: "profile.md", targetPath: "docs/secret-sync/_profile.md" },
  sync: {
    provider: "test",
    pull: { command: "node bootstrap.mjs", cwd: "plugin" },
    config: [{ key: "siteUrl", required: true }],
    secrets: [SECRET_NAME],
  },
};

function makePluginDir(): string {
  const dir = makeTempDir("ak-sync-secrets-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, "profile.md"), "# Profile\n\nNo placeholders.\n");
  // Echoes the secret on purpose, to prove the service masks it in captured output.
  writeFileSync(
    join(dir, "bootstrap.mjs"),
    `console.log("site=" + process.env.SYNC_CONFIG_SITEURL + " token=" + process.env.${SECRET_NAME});` +
      `process.exit(process.env.${SECRET_NAME} === ${JSON.stringify(TOKEN)} ? 0 : 3);`,
  );
  return dir;
}

function makeProjectRepo(): string {
  const repo = join(makeTempDir("ak-sync-secrets-repo-"), "product-repo");
  mkdirSync(repo, { recursive: true });
  gitExecSync(["init"], { cwd: repo });
  return repo;
}

async function insertProject(db: TestDb, repoPath: string): Promise<string> {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(schema.projects).values({
    id: projectId, name: "Secret Project", repoPath, repoName: "secret-project",
    defaultBranch: "main", createdAt: now, updatedAt: now,
  });
  return projectId;
}

describe("plugin secret envelope", () => {
  it("round-trips, and the ciphertext never contains the plaintext", () => {
    const key = randomBytes(32);
    const blob = encryptSecretMap({ A: TOKEN }, key);
    expect(blob).not.toContain(TOKEN);
    expect(decryptSecretMap(blob, key)).toEqual({ A: TOKEN });
  });

  it("reads as empty under a wrong key or a corrupt envelope", () => {
    const blob = encryptSecretMap({ A: TOKEN }, randomBytes(32));
    expect(decryptSecretMap(blob, randomBytes(32))).toEqual({});
    expect(decryptSecretMap("not json", randomBytes(32))).toEqual({});
  });

  it("generates the master key once and reuses it", () => {
    const dir = makeTempDir("ak-sync-secrets-key-");
    const first = loadOrCreateMasterKey(dir);
    expect(first).toHaveLength(32);
    expect(loadOrCreateMasterKey(dir).equals(first)).toBe(true);
  });
});

describe("plugin sync secrets (#1275)", () => {
  let db: TestDb;
  let service: ReturnType<typeof createPluginService>;

  beforeEach(() => {
    db = createTestDb().db;
    service = createPluginService({ database: db as unknown as Database });
    delete process.env[SECRET_NAME];
  });

  afterEach(async () => {
    await stopAllPluginViewsAsync();
    for (const dir of tempDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
    }
  });

  it("stores a secret encrypted, reports presence by name only, and clears with an empty string", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());

    const view = await service.setSyncSecrets(plugin.id, projectId, { [SECRET_NAME]: TOKEN });
    expect(view.secrets).toEqual([{ name: SECRET_NAME, present: true }]);
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    const rows = await db.select().from(schema.preferences);
    expect(rows.some((r) => r.value.includes(TOKEN))).toBe(false);

    const cleared = await service.setSyncSecrets(plugin.id, projectId, { [SECRET_NAME]: "" });
    expect(cleared.secrets).toEqual([{ name: SECRET_NAME, present: false }]);
  });

  it("rejects an undeclared secret name and a non-string value", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await expect(service.setSyncSecrets(plugin.id, projectId, { OTHER: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(service.setSyncSecrets(plugin.id, projectId, { [SECRET_NAME]: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("Test connection fails closed until configured, then runs bootstrap with config + secret in env", async () => {
    const plugin = await service.installPlugin({ source: makePluginDir() });
    const projectId = await insertProject(db, makeProjectRepo());
    await service.enableForProject(plugin.id, projectId);

    const refused = await service.testSyncConnection(plugin.id, projectId);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(SECRET_NAME);

    await service.setSyncConfig(plugin.id, projectId, { siteUrl: "https://example.atlassian.net" });
    await service.setSyncSecrets(plugin.id, projectId, { [SECRET_NAME]: TOKEN });

    const result = await service.testSyncConnection(plugin.id, projectId);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("site=https://example.atlassian.net");
    // The script echoed the token; the service must have masked it.
    expect(result.stdout).toContain("token=***");
    expect(result.stdout).not.toContain(TOKEN);
  });
});
