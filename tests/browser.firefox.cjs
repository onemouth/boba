// Real Firefox DOM/UI smoke tests with a mocked GM bridge and model responses.
// This does NOT install Violentmonkey or validate its privileged API behavior.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox } = require('@playwright/test');

const sourcePath = path.join(__dirname, '../userscript/boba.user.js');

test('Firefox: UI, DOM execution, follow-up, vision attachment, and Stop', async t => {
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://boba-test.local/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Boba test</title><main><h1>Hello</h1><aside id="sidebar">Sidebar</aside><form><input id="name"><button>Submit</button></form></main>` }));
  await page.goto('http://boba-test.local/');
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const root = attach.call(this, options); window.testShadow = root; return root; };
    window.unsafeWindow = window;
    window.GM_getValue = () => ({ server: 'http://127.0.0.1:8787', token: 'test-pairing-token-123456789', shortcut: 'Alt+Shift+B' });
    window.GM_setValue = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_openInTab = () => {};
    window.testRequests = [];
    window.testModelCalls = 0;
    window.testRequestAborted = false;
    window.GM_xmlhttpRequest = options => {
      const route = new URL(options.url).pathname;
      window.testRequests.push({ path: route, body: options.data && JSON.parse(options.data) });
      let result;
      if (route === '/api/health') result = { model: 'test/vision-model' };
      if (route === '/api/prompts') result = { prompts: [] };
      if (route === '/v1/chat/completions') {
        if (window.testHold) return { abort() { window.testRequestAborted = true; options.onabort(); } };
        const count = window.testModelCalls++;
        const message = count === 0 ? { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: {
          name: 'execute_javascript', arguments: JSON.stringify({ code: "document.querySelector('#sidebar').remove(); document.querySelector('h1').textContent='你好'; return { done: true };" }),
        } }] } : { role: 'assistant', content: 'Done' };
        result = { choices: [{ finish_reason: count === 0 ? 'tool_calls' : 'stop', message }] };
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(result) }));
      return { abort() { options.onabort(); } };
    };
  });
  await page.addScriptTag({ content: await fs.readFile(sourcePath, 'utf8') });
  await page.keyboard.press('Alt+Shift+B');
  await page.waitForFunction(() => document.querySelector('boba-panel').style.display === 'block');
  const ui = await page.evaluateHandle(() => window.testShadow);
  await ui.evaluate(root => { root.querySelector('#input').value = 'Translate and remove the sidebar'; root.querySelector('#send').click(); });
  await page.waitForFunction(() => window.testModelCalls === 2 && window.testShadow.querySelector('#send').disabled === false);
  assert.equal(await page.locator('h1').textContent(), '你好');
  assert.equal(await page.locator('#sidebar').count(), 0);
  assert.equal(await page.evaluate(() => document.querySelector('boba-panel').shadowRoot), null);
  await ui.evaluate(root => { root.querySelector('#input').value = 'Refine it'; root.querySelector('#send').click(); });
  await page.waitForFunction(() => window.testModelCalls === 3 && !window.testShadow.querySelector('#send').disabled);
  const users = await page.evaluate(() => window.testRequests.filter(r => r.path === '/v1/chat/completions').at(-1).body.messages.filter(m => m.role === 'user').length);
  assert.equal(users, 2);

  // Attach a real tiny PNG without requesting screen-capture permissions.
  const fileInput = await ui.evaluateHandle(root => root.querySelector('#image'));
  await fileInput.asElement().setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0l8AAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => window.testShadow.querySelector('#attachment').textContent.includes('screenshot.png'));
  await ui.evaluate(root => { root.querySelector('#input').value = 'Describe the image'; root.querySelector('#send').click(); });
  await page.waitForFunction(() => window.testModelCalls === 4 && !window.testShadow.querySelector('#send').disabled);
  const imageMessage = await page.evaluate(() => window.testRequests.filter(r => r.path === '/v1/chat/completions').at(-1).body.messages.filter(m => m.role === 'user').at(-1));
  assert.equal(imageMessage.content[1].type, 'image_url');
  assert.ok(imageMessage.content[1].image_url.url.startsWith('data:image/png;base64,'));

  await page.evaluate(() => { window.testHold = true; });
  await ui.evaluate(root => { root.querySelector('#input').value = 'Wait'; root.querySelector('#send').click(); });
  await page.waitForFunction(() => !window.testShadow.querySelector('#stop').disabled);
  await ui.evaluate(root => root.querySelector('#stop').click());
  await page.waitForFunction(() => window.testRequestAborted && !window.testShadow.querySelector('#send').disabled);
  assert.ok(await ui.evaluate(root => root.querySelector('#log').textContent.includes('Stopped')));
});
