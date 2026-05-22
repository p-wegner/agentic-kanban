import { chromium } from 'playwright';

const exe = 'C:\\Users\\pwegner\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1223\\chrome-headless-shell-win64\\chrome-headless-shell.exe';
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('http://localhost:5173');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'board.png' });

const count = await page.locator('[data-issue-id]').count();
console.log('Issue cards:', count);

if (count > 0) {
  await page.locator('[data-issue-id]').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'workspace-panel.png' });
  console.log('WorkspacePanel screenshot taken');
} else {
  // Try any clickable issue
  const alt = await page.locator('.cursor-pointer h3, .cursor-pointer h4').count();
  console.log('Alt clickables:', alt);
}

await browser.close();
console.log('done');
