// Verify that the packaged extension registers its service worker and can answer
// popup messages in real Chromium. Runs only in the developer/CI environment.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const extension = fileURLToPath(new URL('../dist/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'shade-browser-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers().find(w => w.url().endsWith('/background.js'))
    ?? await context.waitForEvent('serviceworker', {
      predicate: w => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js'),
      timeout: 30000
    });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  const result = await page.evaluate(() => chrome.runtime.sendMessage({action: 'status'}));
  assert.equal(result?.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.profiles, []);
  await page.locator('#masterSwitch').waitFor({state: 'visible'});
  const connectionPromise = context.waitForEvent('page', {timeout:10000});
  await page.locator('#addToggle').click();
  const connection = await connectionPromise;
  await connection.waitForURL(`chrome-extension://${id}/popup.html?window=1`);
  await connection.locator('#address').waitFor({state:'visible'});
  assert.equal(await connection.locator('#password').inputValue(), '');
  console.log('Chromium: service worker, popup and persistent connection window OK');
} finally {
  try { await context?.close(); } finally { await rm(profile, {recursive:true, force:true}); }
}
