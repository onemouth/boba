// Real Firefox DOM and UI, with mocked GM/network/model APIs only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox } = require('@playwright/test');

test('Firefox progress UI separates uncertain effects, manual review and New-chat reset', async t => {
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://boba-progress.local/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Progress fixture</title><p id="counter">0</p>' }));
  await page.goto('http://boba-progress.local/');
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const root = attach.call(this, options); if (this.localName === 'boba-panel') window.testRoot = root; return root; };
    window.unsafeWindow = window;
    window.GM_getValue = () => ({ server: 'http://127.0.0.1:8787', token: 'test-pairing-token-123456789', shortcut: 'Alt+Shift+B' });
    window.GM_setValue = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_openInTab = () => {};
    let requests = 0;
    window.GM_xmlhttpRequest = options => {
      const route = new URL(options.url).pathname;
      let result;
      if (route === '/api/health') result = { model: 'test/progress' };
      else if (route === '/api/prompts') result = { prompts: [] };
      else if (route === '/v1/chat/completions') {
        const message = requests++ === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'partial', type: 'function', function: {
          name: 'execute_javascript', arguments: JSON.stringify({ code: "document.querySelector('#counter').textContent = '1'; throw new Error('After side effect');" }),
        } }] } : { role: 'assistant', content: 'An operation is uncertain. Inspect its effect before retrying.' };
        result = { choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] };
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(result) }));
      return { abort() { options.onabort(); } };
    };
  });
  await page.addScriptTag({ content: await fs.readFile(path.join(__dirname, '../userscript/boba.user.js'), 'utf8') });
  await page.keyboard.press('Alt+Shift+B');
  const ui = await page.evaluateHandle(() => window.testRoot);
  await ui.evaluate(root => { root.querySelector('#input').value = 'Change the counter'; root.querySelector('#send').click(); });
  await page.waitForFunction(() => testRoot.querySelector('#status').textContent === 'Ready' && !testRoot.querySelector('#send').disabled);
  assert.equal(await page.locator('#counter').textContent(), '1');
  assert.equal(await ui.evaluate(root => root.querySelectorAll('[data-state="uncertain"]').length), 1);
  assert.ok((await ui.evaluate(root => root.querySelector('#progress-summary').textContent)).includes('? 1'));
  assert.ok(!(await ui.evaluate(root => root.querySelector('#progress-history').textContent)).includes("textContent = '1'"));
  await ui.evaluate(root => { root.querySelector('#progress').open = true; });
  page.once('dialog', dialog => dialog.accept());
  const review = await ui.evaluateHandle(root => root.querySelector('[data-review="succeeded"]'));
  await review.asElement().click();
  assert.equal(await ui.evaluate(root => root.querySelectorAll('[data-state="uncertain"]').length), 0);
  assert.ok((await ui.evaluate(root => root.querySelector('#progress-history').textContent)).includes('user reviewed; original: uncertain'));
  const fresh = await ui.evaluateHandle(root => root.querySelector('#new'));
  await fresh.asElement().click();
  assert.equal(await ui.evaluate(root => root.querySelector('#progress-history').children.length), 0);
  assert.equal(await page.locator('#counter').textContent(), '1', 'New chat must not undo page effects');
});
