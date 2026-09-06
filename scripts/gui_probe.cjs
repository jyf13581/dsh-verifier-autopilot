// GUI acceptance probe (Phase 3): opens the GUI headless, enters the agent
// session from the sidebar, and asserts both conversation view tabs render
// ('Candidate selection' + 'Verifier'). Needs playwright resolvable via
// NODE_PATH and chromium installed (init: npx playwright install from the dsh
// package dir, then NODE_PATH=<npx cache>/node_modules node scripts/gui_probe.cjs).
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.getByRole('treeitem').filter({ hasText: '交接文档' }).first().click();
  await page.waitForSelector('[role="tab"]:has-text("Candidate selection")', { timeout: 30000 });
  await page.getByRole('tab', { name: 'Candidate selection' }).click();
  await page.waitForTimeout(2000);
  const sel = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      candidateTitle: body.includes('候选选择'),
      selectBtn: body.includes('Select best candidate'),
      hint: body.includes('源会话最近一条直接用户任务') || body.includes('任务描述') || [...document.querySelectorAll('textarea')].some(t => (t.placeholder || '').includes('任务描述')),
    };
  });
  await page.getByRole('tab', { name: 'Verifier' }).click();
  await page.waitForTimeout(2000);
  const ver = await page.evaluate(() => {
    const body = document.body.innerText;
    return { title: body.includes('Verifier 自动验证'), autoToggle: body.includes('自动验证'), modelSelect: body.includes('验证模型') && body.includes('kimi-k3') };
  });
  console.log(JSON.stringify({ selectionPanel: sel, verifierPanel: ver }, null, 1));
  await browser.close();
})().catch(e => { console.error('HARNESS-FAIL', e); process.exit(2) });
