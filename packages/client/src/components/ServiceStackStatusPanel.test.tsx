import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceStackStatusPanel } from "./ServiceStackStatusPanel.js";

describe("ServiceStackStatusPanel", () => {
  it("renders nothing when the workspace has no service stack", () => {
    expect(renderToStaticMarkup(<ServiceStackStatusPanel serviceState={null} />)).toBe("");
    expect(renderToStaticMarkup(<ServiceStackStatusPanel serviceState={undefined} />)).toBe("");
  });

  it("renders a failed stack with the compose error message accessible", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-42-db",
          ports: { db: 54321 },
          envFilePath: "/wt/.kanban-services.env",
          status: "error",
          error: "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services failed");
    expect(html).toContain("kanban-ws-42-db");
    expect(html).toContain("Cannot connect to the Docker daemon");
  });

  it("renders a running stack with its allocated host ports", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: { db: 54321, redis: 54322 },
          envFilePath: "/wt/.kanban-services.env",
          status: "up",
          updatedAt: new Date(Date.now() - 60000).toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services up");
    expect(html).toContain("db:54321");
    expect(html).toContain("redis:54322");
    expect(html).not.toContain("Services failed");
  });

  it("renders a torn-down stack without an error block", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: {},
          envFilePath: "/wt/.kanban-services.env",
          status: "down",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services down");
    expect(html).not.toContain("<pre");
  });

  it("renders NO controls without a workspaceId (read-only)", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: { db: 5000 },
          envFilePath: "/wt/.kanban-services.env",
          status: "up",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );
    expect(html).not.toContain("service-stack-controls");
    expect(html).not.toContain(">Stop<");
  });

  it("shows Stop / Restart / Rebuild / View logs (but not Start / Retry) for an up stack", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        workspaceId="ws-1"
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: { db: 5000 },
          envFilePath: "/wt/.kanban-services.env",
          status: "up",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );
    expect(html).toContain("service-stack-controls");
    expect(html).toContain(">Stop<");
    expect(html).toContain(">Restart<");
    expect(html).toContain(">Rebuild<");
    expect(html).toContain(">View logs<");
    expect(html).not.toContain(">Start<");
    expect(html).not.toContain(">Retry<");
  });

  it("shows Start / Rebuild (but not Stop / Restart) for a down stack", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        workspaceId="ws-1"
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: {},
          envFilePath: "/wt/.kanban-services.env",
          status: "down",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );
    expect(html).toContain(">Start<");
    expect(html).toContain(">Rebuild<");
    expect(html).not.toContain(">Stop<");
    expect(html).not.toContain(">Restart<");
  });

  it("shows Retry for an errored/deferred stack", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        workspaceId="ws-1"
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: {},
          envFilePath: "/wt/.kanban-services.env",
          status: "error",
          error: "at the max_concurrent_stacks cap",
          deferred: true,
          updatedAt: new Date().toISOString(),
        }}
      />,
    );
    expect(html).toContain(">Retry<");
    expect(html).toContain("deferred");
  });
});
