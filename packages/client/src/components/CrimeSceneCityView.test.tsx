import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectStatsResponse } from "@agentic-kanban/shared";
import { buildCrimeSceneCityModel, CrimeSceneCityView } from "./CrimeSceneCityView.js";

const stats: ProjectStatsResponse = {
  commitCount: 12,
  recentCommits: [],
  issueCounts: {},
  detectedBranch: "main",
  codeMetrics: {
    generatedAt: "2026-06-18T10:00:00.000Z",
    productionLoc: 1200,
    testLoc: 300,
    totalLoc: 1500,
    testRatio: 20,
    productionFiles: 20,
    testFiles: 5,
    sourceFilesScanned: 25,
  },
  history: {
    weeks: [],
    contributorCount: 2,
    topContributors: [],
  },
  hotspots: [
    { path: "packages/client/src/components/BoardPage.tsx", additions: 120, deletions: 30, changes: 150 },
    { path: "packages/client/src/components/IssueCard.tsx", additions: 35, deletions: 20, changes: 55 },
    { path: "packages/server/src/services/workspace.service.ts", additions: 10, deletions: 10, changes: 20 },
  ],
};

describe("CrimeSceneCityView", () => {
  it("groups hotspot files into city districts with evidence markers", () => {
    const model = buildCrimeSceneCityModel(stats);

    expect(model.totalChanges).toBe(225);
    expect(model.dominantDistrict).toBe("packages/client");
    expect(model.evidenceCount).toBe(1);
    expect(model.districts.map((district) => district.name)).toEqual(["packages/client", "packages/server"]);
    expect(model.districts[0].buildings[0]).toMatchObject({
      fileName: "BoardPage.tsx",
      heat: "critical",
      marker: 1,
    });
  });

  it("renders the empty state before metrics load", () => {
    const html = renderToStaticMarkup(<CrimeSceneCityView projectId={null} />);

    expect(html).toContain("Code Crime Scene");
    expect(html).toContain("No hotspot files detected");
  });
});
