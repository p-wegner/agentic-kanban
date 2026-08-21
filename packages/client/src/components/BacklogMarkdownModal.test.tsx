// @covers backlogMarkdown.modal [ui, boundary]
//
// Backlog Markdown modal (#688 — this file's 283 LOC / 1 export were referenced by no test
// at all). There is no @testing-library/react in this package, so these are static-markup
// assertions (the repo convention — cf. ButlerQuestionCard.test.tsx, SetupStatusPanel in
// WorkspacePanel.test.tsx): the initial render for each mode, driven entirely by props plus
// the lookups hook's initial (loading) state, since `renderToStaticMarkup` never runs effects
// and so never fires the debounced fetches inside ExportPane/ImportPane.
//
// `useBacklogMarkdownLookups` calls `useQuery`, which throws without a QueryClientProvider —
// wrap every render in one, with no need to mock `apiFetch` since its queryFn is never invoked
// synchronously during a static render.

import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { BacklogMarkdownModal } from "./BacklogMarkdownModal.js";

function renderModal(mode: "export" | "import", onClose: () => void = () => {}) {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BacklogMarkdownModal projectId="proj-1" mode={mode} onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe("BacklogMarkdownModal — export mode", () => {
  it("renders the export pane with title, filter controls and the download/copy actions", () => {
    const html = renderModal("export");
    expect(html).toContain("Export backlog as Markdown");
    expect(html).toContain("backlog-md-modal");
    // filter groups
    expect(html).toContain("Statuses");
    expect(html).toContain("default: every non-terminal column");
    expect(html).toContain("Priority");
    expect(html).toContain("critical");
    expect(html).toContain("high");
    expect(html).toContain("medium");
    expect(html).toContain("low");
    expect(html).toContain("Type");
    expect(html).toContain("feature");
    expect(html).toContain("bug");
    expect(html).toContain("chore");
    expect(html).toContain("epic");
    // text/date filters and toggles
    expect(html).toContain("Text contains");
    expect(html).toContain("Updated since");
    expect(html).toContain("created/updated dates");
    expect(html).toContain("dependencies");
    expect(html).toContain("body only");
    // footer actions
    expect(html).toContain("Copy");
    expect(html).toContain("Download .md");
    expect(html).toContain("kanban-md 1");
  });

  it("shows no live count yet on first render (debounced fetch has not fired)", () => {
    const html = renderModal("export");
    expect(html).toContain("backlog-md-count");
    // Neither the "counting…" busy state nor a resolved count has appeared before the
    // effect-driven fetch runs, which renderToStaticMarkup never triggers.
    expect(html).not.toContain("counting…");
    expect(html).not.toContain("issue(s) selected");
  });

  it("does not render the import pane's controls", () => {
    const html = renderModal("export");
    expect(html).not.toContain("Choose .md file…");
    expect(html).not.toContain("backlog-md-import-text");
  });
});

describe("BacklogMarkdownModal — import mode", () => {
  it("renders the import pane with title, file picker, mode radios and the textarea", () => {
    const html = renderModal("import");
    expect(html).toContain("Import backlog from Markdown");
    expect(html).toContain("Choose .md file…");
    expect(html).toContain("update matching");
    expect(html).toContain("create all");
    expect(html).toContain("backlog-md-import-text");
    expect(html).toContain("Sections the project lacks");
    expect(html).toContain("create as new columns");
    expect(html).toContain("put in the default column");
  });

  it("has no preview yet and the Import button disabled until a preview exists", () => {
    const html = renderModal("import");
    expect(html).not.toContain("backlog-md-preview");
    expect(html).toContain("backlog-md-apply");
    expect(html).toContain("disabled");
    expect(html).toContain(">Import<");
  });

  it("does not render the export pane's controls", () => {
    const html = renderModal("import");
    expect(html).not.toContain("Download .md");
    expect(html).not.toContain("Updated since");
  });
});

describe("BacklogMarkdownModal — shared chrome", () => {
  it("renders a close button for both modes", () => {
    for (const mode of ["export", "import"] as const) {
      const html = renderModal(mode);
      expect(html).toContain('aria-label="Close"');
    }
  });
});
