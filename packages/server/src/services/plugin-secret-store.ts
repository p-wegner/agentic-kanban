import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginSyncSecretsPreferenceKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import type { Database } from "../db/index.js";
import { DATA_DIR } from "../db/data-dir.js";
import { getPreference } from "../repositories/preferences.repository.js";

/**
 * Encrypted per-project plugin secrets (#1275): the values a user types into the board's plugin
 * settings form (an API token, an account email). Stored as ONE AES-256-GCM envelope in a
 * preference row, never in the repo or a plugin profile, and decrypted only to build the env of
 * a plugin subprocess. The key lives in a file beside `kanban.db` (`plugin-secrets.key`,
 * generated on first use) so a copy of the database alone does not carry the plaintext.
 *
 * Reads never return a value to the HTTP layer — callers expose secret NAMES only.
 */

const KEY_FILE = "plugin-secrets.key";
const ENVELOPE_VERSION = 1;

interface SecretEnvelope {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

/** Loads the 32-byte master key from `dir`, generating it (owner-only) on first use. */
export function loadOrCreateMasterKey(dir: string = DATA_DIR): Buffer {
  const file = join(dir, KEY_FILE);
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length === 32) return key;
    throw new Error(`${file} is not a valid 32-byte key — remove it only if no plugin secrets need decrypting`);
  }
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return key;
}

export function encryptSecretMap(secrets: Record<string, string>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  const envelope: SecretEnvelope = {
    v: ENVELOPE_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(envelope);
}

/** Returns `{}` for an unreadable envelope or a wrong key — a lost key must read as "not set". */
export function decryptSecretMap(blob: string, key: Buffer): Record<string, string> {
  try {
    const envelope = JSON.parse(blob) as SecretEnvelope;
    if (envelope.v !== ENVELOPE_VERSION) return {};
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
    const parsed: unknown = JSON.parse(plain);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function createPluginSecretStore(deps: { database: Database; keyDir?: string }) {
  const { database, keyDir } = deps;
  let cachedKey: Buffer | undefined;
  const key = () => (cachedKey ??= loadOrCreateMasterKey(keyDir));

  async function read(pluginSlug: string, projectId: string): Promise<Record<string, string>> {
    const raw = await getPreference(pluginSyncSecretsPreferenceKey(pluginSlug, projectId), database);
    return raw ? decryptSecretMap(raw, key()) : {};
  }

  /** MERGES onto the stored map; an empty string removes that secret. */
  async function write(pluginSlug: string, projectId: string, values: Record<string, string>): Promise<void> {
    const merged = await read(pluginSlug, projectId);
    for (const [name, value] of Object.entries(values)) {
      if (value === "") delete merged[name];
      else merged[name] = value;
    }
    await setPreferenceChecked(database, [
      { key: pluginSyncSecretsPreferenceKey(pluginSlug, projectId), value: encryptSecretMap(merged, key()) },
    ]);
  }

  return { read, write };
}

export type PluginSecretStore = ReturnType<typeof createPluginSecretStore>;
