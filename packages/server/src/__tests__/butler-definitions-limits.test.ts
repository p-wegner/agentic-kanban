// @covers butler.manage.definitions [boundary]
//
// Behaviour: named butler personas are GLOBAL, CRUD-managed and capped at
// MAX_BUTLERS=4; the always-present "default" butler can be renamed/re-modelled
// but never deleted (it holds the back-compat unsuffixed pref keys). The existing
// CRUD coverage (packages/e2e/tests/ui/butler.test.ts) asserts only the happy
// paths — create/list/rename/delete of a named butler. This test pins the two
// INVARIANTS that those tests never exercise:
//   1. the MAX_BUTLERS cap REFUSES a create past the cap (boundary: the create
//      that fills the cap succeeds, the next one fails), and
//   2. the "default" butler can NEVER be deleted, while a non-default named butler
//      CAN — proving the guard is selective, not a blanket refusal.
//
// Store: the definitions live in the `butler_definitions` preference, read/written
// by butler-definitions.service.ts. createTestApp() gives each test its own
// in-memory DB so the global store is isolated per test; afterEach additionally
// deletes every non-default definition so no test leaves >4 (or any leftover)
// behind.
//
// Mutation sensitivity (both cited against butler-definitions.service.ts):
//   - Remove the cap guard at line 79 (`if (defs.length >= MAX_BUTLERS) throw`)
//     ⇒ the over-cap create returns 201 instead of 400 ⇒ the boundary test goes RED.
//   - Remove the default guard at line 116 (`if (id === "default") throw`)
//     ⇒ DELETE /default returns 200 {ok:true} instead of 400 ⇒ that test goes RED.

import { afterEach, describe, expect, it } from "vitest";

import { createButlerDefinitionsRoute } from "../routes/butler-definitions.js";
import { MAX_BUTLERS } from "../services/butler-definitions.service.js";
import { createTestApp as _createTestApp } from "./helpers/test-app.js";

function createTestApp() {
  return _createTestApp((app, db) => {
    app.route("/api/butler-definitions", createButlerDefinitionsRoute(db));
  });
}

type TestApp = ReturnType<typeof createTestApp>["app"];

function listDefinitions(app: TestApp) {
  return app.request("/api/butler-definitions");
}

function createDefinition(app: TestApp, name: string) {
  return app.request("/api/butler-definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

function deleteDefinition(app: TestApp, id: string) {
  return app.request(`/api/butler-definitions/${id}`, { method: "DELETE" });
}

describe("Butler definitions — boundary invariants (cap + un-deletable default)", () => {
  // Each `it` builds its own isolated app/DB; this cleanup is belt-and-suspenders
  // so a created definition can never persist past a test into the global store.
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = undefined;
  });

  function track(app: TestApp) {
    cleanup = async () => {
      const { butlers } = (await (await listDefinitions(app)).json()) as {
        butlers: Array<{ id: string }>;
      };
      for (const b of butlers) {
        if (b.id !== "default") await deleteDefinition(app, b.id);
      }
    };
  }

  it(`enforces MAX_BUTLERS=${MAX_BUTLERS}: the create that fills the cap succeeds, the next is refused`, async () => {
    const { app } = createTestApp();
    track(app);

    // The store starts with exactly the always-present "default" butler.
    const initial = (await (await listDefinitions(app)).json()) as {
      butlers: Array<{ id: string }>;
      max: number;
    };
    expect(initial.max).toBe(MAX_BUTLERS);
    expect(initial.butlers).toHaveLength(1);
    expect(initial.butlers[0].id).toBe("default");

    // Fill the remaining capacity: default + (MAX_BUTLERS - 1) named butlers = the cap.
    const createdIds: string[] = [];
    for (let i = 1; i <= MAX_BUTLERS - 1; i++) {
      const res = await createDefinition(app, `Persona ${i}`);
      expect(res.status).toBe(201);
      const { butler } = (await res.json()) as { butler: { id: string } };
      createdIds.push(butler.id);
    }

    // We are now exactly AT the cap (default + named ones).
    const atCap = (await (await listDefinitions(app)).json()) as {
      butlers: Array<{ id: string }>;
    };
    expect(atCap.butlers).toHaveLength(MAX_BUTLERS);

    // The NEXT create (the (MAX_BUTLERS+1)th butler) is refused with 400 + a
    // documented error — and does NOT land in the store.
    const overCap = await createDefinition(app, "One Too Many");
    expect(overCap.status).toBe(400);
    expect((await overCap.json()).error).toMatch(/at most/i);

    const afterRefusal = (await (await listDefinitions(app)).json()) as {
      butlers: Array<{ id: string }>;
    };
    expect(afterRefusal.butlers).toHaveLength(MAX_BUTLERS);
    expect(afterRefusal.butlers.map((b) => b.name)).not.toContain("One Too Many");
  });

  it("refuses to delete the 'default' butler but allows deleting a named one (guard is selective)", async () => {
    const { app } = createTestApp();
    track(app);

    // A deletable, non-default named butler to prove the guard is selective.
    const created = await createDefinition(app, "Disposable");
    expect(created.status).toBe(201);
    const namedId = ((await created.json()) as { butler: { id: string } }).butler.id;
    expect(namedId).not.toBe("default");

    // Deleting 'default' is REFUSED — it stays present.
    const delDefault = await deleteDefinition(app, "default");
    expect(delDefault.status).toBe(400);
    expect((await delDefault.json()).error).toMatch(/default butler cannot be deleted/i);

    const afterDefaultDelete = (await (await listDefinitions(app)).json()) as {
      butlers: Array<{ id: string }>;
    };
    expect(afterDefaultDelete.butlers.map((b) => b.id)).toContain("default");

    // Deleting the named one SUCCEEDS — proving the refusal above is specific to
    // 'default', not a blanket "delete is disabled".
    const delNamed = await deleteDefinition(app, namedId);
    expect(delNamed.status).toBe(200);
    expect(await delNamed.json()).toMatchObject({ ok: true });

    const afterNamedDelete = (await (await listDefinitions(app)).json()) as {
      butlers: Array<{ id: string }>;
    };
    const remainingIds = afterNamedDelete.butlers.map((b) => b.id);
    expect(remainingIds).toContain("default");
    expect(remainingIds).not.toContain(namedId);
  });
});
