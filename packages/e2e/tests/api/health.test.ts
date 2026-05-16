import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Health API", () => {
  test("GET /health returns 200 with ok status", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
