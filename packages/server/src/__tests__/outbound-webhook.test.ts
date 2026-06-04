import { describe, it, expect } from "vitest";
import { validateWebhookUrl } from "@agentic-kanban/shared/lib";

describe("validateWebhookUrl", () => {
  it("accepts localhost http URL", () => {
    expect(validateWebhookUrl("http://localhost:9000/webhook")).toBe("http://localhost:9000/webhook");
  });

  it("accepts 127.0.0.1 http URL", () => {
    expect(validateWebhookUrl("http://127.0.0.1:8080/hook")).toBe("http://127.0.0.1:8080/hook");
  });

  it("accepts https localhost URL", () => {
    expect(validateWebhookUrl("https://localhost:443/hook")).toBe("https://localhost:443/hook");
  });

  it("trims surrounding whitespace", () => {
    expect(validateWebhookUrl("  http://localhost:9000/webhook  ")).toBe("http://localhost:9000/webhook");
  });

  it("rejects non-loopback host", () => {
    expect(validateWebhookUrl("http://example.com/webhook")).toBeNull();
  });

  it("rejects 0.0.0.0", () => {
    expect(validateWebhookUrl("http://0.0.0.0:9000/webhook")).toBeNull();
  });

  it("rejects non-http scheme", () => {
    expect(validateWebhookUrl("ftp://localhost:9000/webhook")).toBeNull();
  });

  it("rejects malformed URL", () => {
    expect(validateWebhookUrl("not a url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(validateWebhookUrl("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(validateWebhookUrl(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(validateWebhookUrl(undefined)).toBeNull();
  });
});
