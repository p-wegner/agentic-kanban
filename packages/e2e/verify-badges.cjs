const { chromium } = require('playwright');

(async () => {
  const executablePath = 'C:\\Users\\pwegner\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe';
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('http://127.0.0.1:5173');
  await page.waitForTimeout(4000);

  await page.getByText('worspace sessions view should include').click();
  await page.waitForTimeout(1500);
  await page.getByText('master').last().click();
  await page.waitForTimeout(1500);

  // Screenshot just the right panel (workspace panel)
  const panel = page.locator('[class*="slide-in"], [class*="fixed"][class*="right-0"], [class*="h-full"][class*="right"]').last();
  await panel.screenshot({ path: '../../workspace-panel-zoom.png' }).catch(async () => {
    // fallback: screenshot the right portion
    await page.screenshot({ path: '../../workspace-panel-zoom.png', clip: { x: 950, y: 0, width: 650, height: 900 } });
  });

  await browser.close();
})();
