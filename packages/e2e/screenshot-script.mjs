import { chromium } from "@playwright/test";
const browser = await chromium.launch({ 
  headless: true,
  executablePath: "C:/Users/pwegner/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe"
});
const page = await browser.newPage();
await page.goto("http://localhost:5173");
await page.waitForTimeout(3000);
// Click on an "In Progress" issue that likely has a workspace
const inProgressCards = await page.locator(".cursor-pointer").all();
await inProgressCards[3].click();
await page.waitForTimeout(1500);
await page.screenshot({ path: "C:/andrena/agentic-kanban/issue-panel.png" });
// Look for workspace/branch link
const wsLink = page.locator("text=feature/").first();
if (await wsLink.isVisible()) {
  await wsLink.click();
  await page.waitForTimeout(1000);
}
await page.screenshot({ path: "C:/andrena/agentic-kanban/workspace-view.png" });
await browser.close();
