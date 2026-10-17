// Real Firefox CSP/Trusted Types startup regression. GM APIs are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox } = require('@playwright/test');

test('Firefox: UI opens under strict CSP/Trusted Types without unsafe HTML or eval', async t => {
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const source = await fs.readFile(path.join(__dirname, '../userscript/boba.user.js'), 'utf8');
  await page.route('http://boba-csp.local/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/boba.js') return route.fulfill({ contentType: 'application/javascript', body: source });
    if (url.pathname === '/setup.js') return route.fulfill({ contentType: 'application/javascript', body: `
      window.module = {exports: {ownedByPage: true}};
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(opts) { const root = attach.call(this, opts); if (this.localName === 'boba-panel') window.testRoot = root; return root; };
      window.unsafeWindow = window;
      window.GM_getValue = () => ({});
      window.GM_setValue = () => {};
      window.GM_registerMenuCommand = () => {};
      window.GM_openInTab = () => {};
      window.GM_xmlhttpRequest = () => { throw new Error('No requests expected without pairing'); };
    ` });
    return route.fulfill({ contentType: 'text/html', headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'",
    }, body: '<!doctype html><title>Strict CSP fixture</title><main>Article</main><script src="/setup.js"></script><script src="/boba.js"></script>' });
  });
  await page.goto('http://boba-csp.local/');
  assert.equal(await page.locator('boba-panel').count(), 1);
  assert.equal(await page.evaluate(() => module.exports.ownedByPage), true);
  const sinkError = await page.evaluate(() => {
    try { document.createElement('div').attachShadow({ mode: 'open' }).innerHTML = '<b>Blocked</b>'; return null; }
    catch (error) { return error.name; }
  });
  assert.equal(sinkError, 'TypeError', 'fixture must actually enforce TrustedHTML');
  await page.keyboard.press('Alt+Shift+B');
  assert.equal(await page.locator('boba-panel').evaluate(e => e.style.display), 'block');
  assert.equal(await page.evaluate(() => testRoot.querySelector('#settings').style.display), 'block');
  assert.equal(await page.evaluate(() => testRoot.querySelector('#input').tagName), 'TEXTAREA');
  assert.deepEqual(errors, []);
});
