// Pay every sandbox intent in out/intents.json through Airwallex's own card
// elements (out/pay.html served on localhost), with the published sandbox test
// card. For accounts without native card API access; see sandbox.createIntents.
//   PLAYWRIGHT=<path to playwright> node src/paybot.mjs [base-url] [from] [to]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const base = process.argv[2] || 'http://localhost:8793/pay.html';
const n = JSON.parse(readFileSync('out/intents.json', 'utf8')).length;
const from = Number(process.argv[3] || 0), to = Number(process.argv[4] || n);
const card = { 'card-number': process.env.AIRWALLEX_TEST_CARD || '4035501000000008', expiry: '1230', cvc: '123' };

const browser = await chromium.launch();
const page = await browser.newPage();
for (let i = from; i < to; i++) {
  await page.goto(`${base}?i=${i}`);
  for (const [kind, value] of Object.entries(card)) {
    const f = page.frameLocator(`iframe[src*="elements/${kind}"]`);
    await f.locator('input').first().pressSequentially(value, { delay: 40 });
  }
  await page.click('#pay');
  await page.waitForFunction(() => document.getElementById('out').textContent, null, { timeout: 90000 })
    .catch(() => {});
  console.log(i, await page.textContent('h1'), '->', (await page.textContent('#out')) || 'NO ANSWER in 90s');
}
await browser.close();
