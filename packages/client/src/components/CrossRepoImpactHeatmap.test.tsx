import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildCrossRepoImpact,
  type ImpactRepoInput,
  type ImpactWorkspaceInput,
} from "../lib/crossRepoImpact.js";
import { CrossRepoImpactHeatmapView } from "./CrossRepoImpactHeatmap.js";

const BACKEND = "/repo/backend";
const AUTH = "/repo/auth";
const WEB = "/repo/web";

const REPOS: ImpactRepoInput[] = [
  { name: "backend", path: BACKEND, isLeading: true },
  { name: "auth", path: AUTH, isLeading: false },
  { name: "web", path: WEB, isLeading: false },
];

function ws(
  id: string,
  repoDiffs: ImpactWorkspaceInput["repoDiffs"],
  overrides: Partial<ImpactWorkspaceInput> = {},
): ImpactWorkspaceInput {
  return {
    id,
    issueNumber: 1,
    issueTitle: "Ticket",
    branch: "feature/x",
    status: "active",
    repoDiffs,
    ...overrides,
  };
}

function render(data: ReturnType<typeof buildCrossRepoImpact> | null, opts: { loading?: boolean; error?: string | null } = {}) {
  return renderToStaticMarkup(
    <CrossRepoImpactHeatmapView data={data} loading={opts.loading ?? false} error={opts.error ?? null} />,
  );
}

describe("CrossRepoImpactHeatmapView", () => {
  it("renders a cell per column with the correct intensity bucket from diff data", () => {
    const data = buildCrossRepoImpact(REPOS, [
      ws("w1", [
        { path: BACKEND, filesChanged: 1, insertions: 5, deletions: 2 }, // low
        { path: AUTH, filesChanged: 8, insertions: 60, deletions: 30 }, // high
      ]),
    ]);
    const html = render(data);
    expect(html).toContain('data-bucket="low"');
    expect(html).toContain('data-bucket="high"');
    // The untouched web repo renders as a none cell.
    expect(html).toContain('data-bucket="none"');
    // Cell shows the files/lines footprint.
    expect(html).toContain("1f·7l");
    expect(html).toContain("8f·90l");
  });

  it("flags a cross-cutting row and shows the marker", () => {
    const data = buildCrossRepoImpact(REPOS, [
      ws("w1", [
        { path: BACKEND, filesChanged: 2, insertions: 10, deletions: 0 },
        { path: WEB, filesChanged: 1, insertions: 3, deletions: 1 },
      ]),
    ]);
    const html = render(data);
    expect(html).toContain('data-crosscutting="true"');
    expect(html).toContain("cross-cutting");
  });

  it("marks a hot column when two workspaces touch the same repo", () => {
    const data = buildCrossRepoImpact(REPOS, [
      ws("w1", [{ path: BACKEND, filesChanged: 1, insertions: 5, deletions: 0 }]),
      ws("w2", [{ path: BACKEND, filesChanged: 1, insertions: 2, deletions: 0 }]),
    ]);
    const html = render(data);
    expect(html).toContain('data-hot="true"');
    // Summary reflects exactly one hot repo.
    expect(html).toContain('data-testid="impact-hot-count">1<');
  });

  it("marks contended cells when overlapping workspaces change the same repo", () => {
    const data = buildCrossRepoImpact(
      REPOS,
      [
        ws("w1", [{ path: BACKEND, filesChanged: 2, insertions: 10, deletions: 0 }]),
        ws("w2", [{ path: BACKEND, filesChanged: 1, insertions: 4, deletions: 0 }]),
      ],
      [{ a: "w1", b: "w2" }],
    );
    const html = render(data);
    expect(html).toContain('data-contended="true"');
    expect(html).toContain("⚠");
  });

  it("always renders the legend and summary counts", () => {
    const data = buildCrossRepoImpact(REPOS, [
      ws("w1", [{ path: BACKEND, filesChanged: 1, insertions: 5, deletions: 0 }]),
    ]);
    const html = render(data);
    expect(html).toContain('data-testid="impact-legend"');
    expect(html).toContain('data-testid="impact-summary"');
    expect(html).toContain("Intensity");
  });

  it("degrades gracefully for an empty (no active workspaces) project", () => {
    const data = buildCrossRepoImpact(REPOS, []);
    const html = render(data);
    expect(html).toContain('data-testid="impact-empty"');
    expect(html).toContain("No active workspaces");
    // No matrix rendered when there is nothing to show.
    expect(html).not.toContain('data-testid="cross-repo-impact-matrix"');
  });

  it("degrades gracefully for a project with no repos", () => {
    const data = buildCrossRepoImpact([], [ws("w1", [])]);
    const html = render(data);
    expect(html).toContain("No repos to map");
  });

  it("renders a single-repo project without any cross-cutting rows", () => {
    const data = buildCrossRepoImpact(
      [{ name: "backend", path: BACKEND, isLeading: true }],
      [ws("w1", [{ path: BACKEND, filesChanged: 3, insertions: 20, deletions: 5 }])],
    );
    const html = render(data);
    expect(html).toContain('data-testid="cross-repo-impact-matrix"');
    expect(html).not.toContain('data-crosscutting="true"');
  });

  it("shows a loading placeholder and an error state", () => {
    expect(render(null, { loading: true })).toContain("Loading change-impact…");
    expect(render(null, { error: "boom" })).toContain("boom");
  });
});
