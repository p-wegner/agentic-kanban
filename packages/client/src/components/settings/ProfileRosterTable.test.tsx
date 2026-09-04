/**
 * The roster table (#1028) and the project roster editor.
 *
 * There is no @testing-library/react in this package, so these are static-markup assertions
 * (the repo convention — cf. `MonitorPopover.test.tsx`, `ButlerQuestionCard.test.tsx`).
 *
 * Two acceptance criteria live here: the table renders with quota `unknown` without breaking,
 * and a globally forbidden profile cannot be widened from the project editor.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProfileRosterProfile, ProfileRosterResponse } from "@agentic-kanban/shared/types";
import { ProfileRosterTable } from "./ProfileRosterTable.js";
import { ProjectRosterEditor, type RosterCandidate } from "./ProjectRosterEditor.js";
import { ProfileRosterWarningsBody } from "../monitor/ProfileRosterWarningsSection.js";

const NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");

function profile(over: Partial<ProfileRosterProfile> = {}): ProfileRosterProfile {
  return {
    id: "claude:anth",
    provider: "claude",
    name: "anth",
    role: "pool",
    dedicatedProject: null,
    roleObservedAt: null,
    roleConflict: false,
    conflictingRoles: [],
    roleWarnings: [],
    loggedIn: true,
    inRing: true,
    coolingUntil: null,
    quota: { status: "ok", usedPct5h: 40, usedPct7d: 12, resetAt5h: null, measuredAt: "2026-09-04T11:59:00.000Z", ageSeconds: 60, stale: false },
    ...over,
  };
}

function response(profiles: ProfileRosterProfile[], over: Partial<ProfileRosterResponse> = {}): ProfileRosterResponse {
  return {
    profiles,
    project: null,
    quotaError: null,
    roleHintCommand: "claude-pick profile attr <profile> --role pool|reserve|forbidden",
    generatedAt: "2026-09-04T12:00:00.000Z",
    ...over,
  };
}

describe("ProfileRosterTable", () => {
  it("renders a profile with an UNKNOWN quota reading without breaking", () => {
    const html = renderToStaticMarkup(
      <ProfileRosterTable
        nowMs={NOW_MS}
        error={null}
        roster={response([
          profile({
            id: "claude:stale",
            name: "stale",
            quota: { status: "unknown", usedPct5h: null, usedPct7d: null, resetAt5h: null, measuredAt: null, ageSeconds: null, stale: true },
          }),
        ])}
      />,
    );

    expect(html).toContain("claude:stale");
    // The word, never a dash and never a zero: an unmeasured window is neither exhausted
    // nor empty, and the roster never reads it as exhausted.
    expect(html).toContain("unknown");
    expect(html).not.toContain("0%");
    expect(html).toContain("never");
  });

  it("renders the role, a role conflict, and the read-only hint that names claude-pick", () => {
    const html = renderToStaticMarkup(
      <ProfileRosterTable
        nowMs={NOW_MS}
        error={null}
        roster={response([
          profile({ id: "claude:privat", name: "privat", role: "reserve" }),
          profile({ id: "claude:training", name: "training", role: "forbidden", roleConflict: true, conflictingRoles: ["pool", "forbidden"] }),
        ])}
      />,
    );

    expect(html).toContain("reserve");
    expect(html).toContain("forbidden");
    expect(html).toContain("role conflict");
    // The board never writes a role, so the screen has to say where one is changed.
    expect(html).toContain("claude-pick profile attr");
  });

  it("still renders roles and cooldowns when the quota source failed", () => {
    const html = renderToStaticMarkup(
      <ProfileRosterTable
        nowMs={NOW_MS}
        error={null}
        roster={response(
          [profile({ coolingUntil: "2026-09-04T12:45:00.000Z" })],
          { quotaError: "no oauth token" },
        )}
      />,
    );
    expect(html).toContain("Quota source unavailable");
    expect(html).toContain("no oauth token");
    expect(html).toContain("claude:anth");
    expect(html).toContain("45m");
  });
});

describe("ProjectRosterEditor", () => {
  const candidates: RosterCandidate[] = [
    { id: "claude:anth", provider: "claude", name: "anth", globalRole: "pool" },
    { id: "claude:privat", provider: "claude", name: "privat", globalRole: "reserve" },
    { id: "claude:training", provider: "claude", name: "training", globalRole: "forbidden" },
  ];

  function render(over: Partial<React.ComponentProps<typeof ProjectRosterEditor>> = {}) {
    return renderToStaticMarkup(
      <ProjectRosterEditor
        candidates={candidates}
        entries={[]}
        onRoleChange={() => {}}
        reserveAllowed={false}
        onReserveAllowedChange={() => {}}
        exhaustedPct={90}
        onExhaustedPctChange={() => {}}
        project={null}
        {...over}
      />,
    );
  }

  it("offers only narrowing roles — a globally forbidden profile cannot be widened", () => {
    const html = render();
    // One `<select>` per candidate. The forbidden one must offer `forbidden` and nothing
    // above it; anything else would make a global `forbidden` liftable per project.
    const selects = html.split("<select").slice(1);
    expect(selects).toHaveLength(3);

    const forbiddenSelect = selects[2];
    expect(forbiddenSelect).toContain('value="forbidden"');
    expect(forbiddenSelect).not.toContain('value="pool"');
    expect(forbiddenSelect).not.toContain('value="reserve"');

    // The reserve account may be narrowed to forbidden but not widened to pool.
    const reserveSelect = selects[1];
    expect(reserveSelect).toContain('value="reserve"');
    expect(reserveSelect).toContain('value="forbidden"');
    expect(reserveSelect).not.toContain('value="pool"');

    // An ordinary account keeps all three.
    expect(selects[0]).toContain('value="pool"');
  });

  it("says which role the ACCOUNT declares, so a missing option has a visible reason", () => {
    const html = render();
    expect(html).toContain("globally reserve");
    expect(html).toContain("globally forbidden");
  });

  it("reports an empty roster as unrestricted and a populated one as a restriction", () => {
    expect(render()).toContain("Unrestricted");
    expect(render({ entries: [{ provider: "claude", name: "anth", role: "pool" }] })).toContain("Restricted to 1 profile");
  });

  it("shows the refused widening rather than swallowing it", () => {
    expect(render({ rejection: "claude:training is globally \"forbidden\"" })).toContain("claude:training is globally");
  });

  it("explains what the roster would do right now, including a hold", () => {
    const held = render({
      project: {
        projectId: "p1", projectName: "demo", entries: [], restricted: true, closed: true, malformed: false,
        source: "roster", reserveAllowed: false, exhaustedPct: 90,
        selection: { profileId: null, usedReserve: false, reserveNote: null, holdReason: "every pool profile is exhausted or cooling", refused: false, poolOrder: [] },
      },
    });
    expect(held).toContain("Would hold");
    expect(held).toContain("every pool profile is exhausted or cooling");
  });
});

describe("ProfileRosterWarningsBody", () => {
  it("renders nothing when there is neither a conflict nor a reserve start", () => {
    expect(renderToStaticMarkup(<ProfileRosterWarningsBody roster={response([profile()])} />)).toBe("");
  });

  it("warns about a reserve start and about a cross-machine role conflict", () => {
    const html = renderToStaticMarkup(
      <ProfileRosterWarningsBody
        roster={response(
          [profile({ id: "claude:training", name: "training", role: "forbidden", roleConflict: true, conflictingRoles: ["pool", "forbidden"] })],
          {
            project: {
              projectId: "p1", projectName: "demo", entries: [], restricted: true, closed: true, malformed: false,
              source: "roster", reserveAllowed: true, exhaustedPct: 90,
              selection: { profileId: "claude:privat", usedReserve: true, reserveNote: "RESERVE start on claude:privat", holdReason: null, refused: false, poolOrder: ["claude:anth"] },
            },
          },
        )}
      />,
    );
    expect(html).toContain("Reserve start");
    expect(html).toContain("claude:privat");
    expect(html).toContain("Role conflict");
    expect(html).toContain("pool vs forbidden");
  });
});
