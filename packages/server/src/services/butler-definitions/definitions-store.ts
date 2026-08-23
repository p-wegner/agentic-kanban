/**
 * Butler definitions — the set of named butlers the user can keep warm, e.g.
 * "Smart" (opus) and "Quick" (haiku). Definitions are GLOBAL (shared across all
 * projects, per the design); each project still keeps its own warm session and
 * conversation context per butler (see butler-sdk.service.ts).
 *
 * Stored as a single JSON-array preference (`butler_definitions`). The model lives
 * on the definition — switching a butler's model in the UI updates it here. Profile
 * (auth/endpoint) stays per-project and is shared by all of a project's butlers.
 *
 * This module is the CRUD half, split out under #819. What it needs is the preference
 * repository and a slugifier; it deliberately knows nothing about how a butler is
 * LAUNCHED (see `./launch-config.ts` for that half and for the seam argument).
 */
import type { Database } from "../../db/index.js";
import { getPreference, setPreference } from "../../repositories/preferences.repository.js";
import { slugify } from "@agentic-kanban/shared/lib/slugify";

export interface ButlerDefinition {
  /** Stable kebab-case id. "default" is reserved for the always-present legacy butler. */
  id: string;
  /** Display name shown in the switcher, e.g. "Smart". */
  name: string;
  /** Provider-specific model alias ("" = profile/CLI default). */
  model: string;
  /** Agent provider for this butler ("claude" | "codex"). When absent, inherits the global provider. */
  provider?: "claude" | "codex";
}

const PREF_KEY = "butler_definitions";

/** Hard cap on how many butlers can be defined — keeps the set semantic and the UI legible. */
export const MAX_BUTLERS = 4;

/** The always-present legacy butler. Its id maps to the pre-existing (unsuffixed) pref keys. */
export const DEFAULT_BUTLER: ButlerDefinition = { id: "default", name: "Butler", model: "" };

function toSlug(name: string): string {
  return slugify(name, { maxLength: 32, fallback: "butler" });
}

/** Read the defined butlers, always guaranteeing the "default" butler is present and first. */
export async function listButlerDefinitions(database: Database): Promise<ButlerDefinition[]> {
  let parsed: ButlerDefinition[] = [];
  const raw = await getPreference(PREF_KEY, database);
  if (raw) {
    try {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        parsed = arr
          .filter((d): d is ButlerDefinition => !!d && typeof (d as ButlerDefinition).id === "string")
          .map((d) => ({
            id: d.id,
            name: String(d.name ?? d.id),
            model: String(d.model ?? ""),
            ...(d.provider === "claude" || d.provider === "codex" ? { provider: d.provider } : {}),
          }));
      }
    } catch {
      /* corrupt pref → fall back to just the default below */
    }
  }
  const withoutDefault = parsed.filter((d) => d.id !== "default");
  const existingDefault = parsed.find((d) => d.id === "default");
  return [existingDefault ?? DEFAULT_BUTLER, ...withoutDefault].slice(0, MAX_BUTLERS);
}

export async function getButlerDefinition(database: Database, id: string): Promise<ButlerDefinition | undefined> {
  return (await listButlerDefinitions(database)).find((d) => d.id === id);
}

/**
 * Coded domain error so the central `domainErrorHandler` can map these (#510).
 *
 * These used to be plain `Error`s, which the handler can only treat as a 500 — so the
 * routes each wrapped their call in a catch-all that turned ANY failure into a 400 with a
 * generic "Failed to create butler" message. That hid real faults behind a 400 AND
 * reported a missing butler as a bad request. With a code, the route needs no try/catch
 * and "Butler not found" correctly becomes a 404.
 */
export class ButlerDefinitionError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
  ) {
    super(message);
  }
}

async function persist(database: Database, defs: ButlerDefinition[]): Promise<void> {
  await setPreference(PREF_KEY, JSON.stringify(defs), database);
}

/** Create a new named butler. Throws on cap/validation. Generates a unique slug from the name. */
export async function createButlerDefinition(
  database: Database,
  input: { name: string; model?: string; provider?: "claude" | "codex" },
): Promise<ButlerDefinition> {
  const name = input.name.trim();
  if (!name) throw new ButlerDefinitionError("Butler name is required", "BAD_REQUEST");
  const defs = await listButlerDefinitions(database);
  if (defs.length >= MAX_BUTLERS) throw new ButlerDefinitionError(`At most ${MAX_BUTLERS} butlers are allowed`, "BAD_REQUEST");
  const base = toSlug(name);
  let id = base;
  let n = 2;
  const taken = new Set(defs.map((d) => d.id));
  while (taken.has(id) || id === "default") id = `${base}-${n++}`;
  const def: ButlerDefinition = {
    id,
    name,
    model: input.model ?? "",
    ...(input.provider ? { provider: input.provider } : {}),
  };
  await persist(database, [...defs, def]);
  return def;
}

/** Update a butler's name, model, and/or provider. The "default" butler can be renamed and re-modelled but never removed. */
export async function updateButlerDefinition(
  database: Database,
  id: string,
  patch: { name?: string; model?: string; provider?: "claude" | "codex" | null },
): Promise<ButlerDefinition> {
  const defs = await listButlerDefinitions(database);
  const idx = defs.findIndex((d) => d.id === id);
  if (idx === -1) throw new ButlerDefinitionError("Butler not found", "NOT_FOUND");
  const next: ButlerDefinition = {
    ...defs[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim() || defs[idx].name } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.provider !== undefined ? (patch.provider ? { provider: patch.provider } : { provider: undefined }) : {}),
  };
  defs[idx] = next;
  await persist(database, defs);
  return next;
}

export async function deleteButlerDefinition(database: Database, id: string): Promise<void> {
  if (id === "default") throw new ButlerDefinitionError("The default butler cannot be deleted", "BAD_REQUEST");
  const defs = await listButlerDefinitions(database);
  if (!defs.some((d) => d.id === id)) throw new ButlerDefinitionError("Butler not found", "NOT_FOUND");
  await persist(database, defs.filter((d) => d.id !== id));
}
