import { test, expect } from "@playwright/test";

test.describe("Health API", () => {
  test("GET /health returns 200 with ok status", async ({ request }) => {
    const res = await request.get("http://localhost:3001/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
