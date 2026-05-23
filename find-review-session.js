async page => {
  // Look for a workspace with sessions - use the All Workspaces panel
  const allWs = page.locator('button[title*="All Workspaces"], button:has-text("All Workspaces")');
  if (await allWs.count() > 0) {
    await allWs.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'all-workspaces.png' });
}
