// Real Chromium + real Go server/host-file tools. Only OpenRouter is mocked by
// the opt-in Go fixture; no user config, workspace, or external API is touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { chromium } = require('@playwright/test');

const token = 'test-pairing-token-123456789';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'boba-browser-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fixture');
  await require('node:util').promisify(execFile)('go', ['test', '-c', '-o', executable, '.'], { cwd: path.resolve(__dirname, '..') });
  const child = spawn(executable, ['-test.run=^TestDevtoolsBrowserFixture$', '-test.v'], {
    env: { ...process.env, BOBA_BROWSER_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Fixture startup timed out: ${output}`)); }, 30000);
    child.stdout.on('data', data => {
      output += data;
      const match = /BOBA_FIXTURE_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', data => { output += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (!output.includes('BOBA_FIXTURE_READY')) reject(new Error(`Fixture exited ${code}: ${output}`)); });
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await once(child, 'exit');
    clearTimeout(timer);
  });
  return url;
}
async function target(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/coop') res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url === '/strict') res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'");
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Target article</title><main><h1>Article</h1><aside id="sidebar">Sidebar</aside><form><input id="name"><textarea id="notes"></textarea><button>Submit</button></form></main>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function waitReady(popup) {
  await popup.waitForFunction(() => !window.testRoot.querySelector('#send').disabled && window.testRoot.querySelector('#status').textContent === 'Ready');
}
async function send(ui, text) {
  await ui.evaluate((root, value) => { root.querySelector('#input').value = value; root.querySelector('#send').click(); }, text);
}

test('Chromium snippet: protected controller, actual DOM/files, follow-up, Stop, and reload', { timeout: 90000 }, async t => {
  const base = await fixture(t);
  const site = await target(t);
  const snippet = await (await fetch(base + '/devtools/boba-snippet.js')).text();
  assert.ok(snippet.includes(base));
  assert.ok(!snippet.includes(token));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attach.call(this, options);
      if (this.localName === 'boba-panel') window.testRoot = root;
      return root;
    };
    window.testPortTraffic = [];
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...rest) { window.testPortTraffic.push(message); return post.call(this, message, ...rest); };
  });
  const page = await context.newPage();
  await page.goto(site);
  const targetRequests = [];
  page.on('request', request => targetRequests.push(request.url()));
  const popupReady = page.waitForEvent('popup');
  // CDP page evaluation supplies the same page realm used by a DevTools snippet.
  await page.evaluate(snippet);
  const popup = await popupReady;
  await popup.waitForLoadState();
  await popup.locator('#connect:enabled').waitFor();
  assert.ok((await popup.locator('#connection').textContent()).includes(site));
  await popup.locator('#connect').click();
  const ui = await popup.evaluateHandle(() => window.testRoot);
  await ui.evaluate((root, token) => {
    root.querySelector('#token').value = token;
    root.querySelector('#settings').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }, token);
  await popup.waitForFunction(() => testRoot.querySelector('#status').textContent === 'test/devtools');
  await send(ui, 'first: inspect, hide the sidebar, fill the name, save a Markdown file. Do not submit.');
  await waitReady(popup);
  assert.equal(await page.locator('#name').inputValue(), 'Boba');
  assert.equal(await page.locator('#sidebar').evaluate(e => getComputedStyle(e).display), 'none');
  const saved = await fetch(base + '/api/files', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'read_file', path: 'output/devtools-smoke.md' }) });
  assert.equal(saved.status, 200);
  assert.ok((await saved.json()).result.includes('protected controller'));
  await send(ui, 'follow-up: fill the notes too, keep previous changes');
  await waitReady(popup);
  assert.equal(await page.locator('#notes').inputValue(), 'Follow-up kept the name');
  assert.equal(await page.locator('#name').inputValue(), 'Boba');
  assert.deepEqual(await (await fetch(base + '/fixture/status')).json(), { cancelled: false, wrong_context: false });
  assert.ok(!targetRequests.some(url => /\/api\/files|\/v1\/chat/.test(url)));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('boba.devtools.settings')), null);
  assert.ok(!(await page.evaluate(() => JSON.stringify(window.testPortTraffic))).includes(token));

  // Rerunning focuses the existing controller instead of creating another one.
  const count = context.pages().length;
  await page.evaluate(snippet);
  assert.equal(context.pages().length, count);

  await send(ui, 'wait-for-stop');
  await popup.waitForFunction(() => testRoot.querySelector('#status').textContent.startsWith('Thinking'));
  // Let the request reach the fake upstream before cancelling it.
  await new Promise(resolve => setTimeout(resolve, 150));
  await ui.evaluate(root => root.querySelector('#stop').click());
  await waitReady(popup);
  let cancellation;
  for (let i = 0; i < 30; i++) {
    cancellation = await (await fetch(base + '/fixture/status')).json();
    if (cancellation.cancelled) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(cancellation.cancelled, true);
  await page.reload();
  await popup.waitForFunction(() => testRoot.querySelector('#status').textContent === 'Disconnected');
  assert.equal(await ui.evaluate(root => root.querySelector('#send').disabled), true);
  assert.equal(await page.evaluate(() => typeof window.__bobaDevtools), 'undefined');
});

test('Chromium strict CSP: snippet connects and structured tools work without page network/eval', { timeout: 90000 }, async t => {
  const base = await fixture(t);
  const site = await target(t);
  const snippet = await (await fetch(base + '/devtools/boba-snippet.js')).text();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) { const root = attach.call(this, options); if (this.localName === 'boba-panel') window.testRoot = root; return root; };
  });
  const page = await context.newPage();
  await page.goto(site + '/strict');
  const popupReady = page.waitForEvent('popup');
  await page.evaluate(snippet);
  const popup = await popupReady;
  await popup.locator('#connect:enabled').waitFor();
  await popup.locator('#connect').click();
  const ui = await popup.evaluateHandle(() => window.testRoot);
  await ui.evaluate((root, token) => { root.querySelector('#token').value = token; root.querySelector('#settings').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }, token);
  await popup.waitForFunction(() => testRoot.querySelector('#status').textContent === 'test/devtools');
  await send(ui, 'first strict task');
  await waitReady(popup);
  assert.equal(await page.locator('#name').inputValue(), 'Boba');
  // Runtime Function execution can be blocked even though the debugger launched
  // the snippet. Do not promise arbitrary-JS CSP bypass.
  assert.ok((await ui.evaluate(root => root.querySelector('#log').textContent)).includes('CSP'));
  await send(ui, 'structured: add a Traditional Chinese counterpart to the heading without eval');
  await waitReady(popup);
  assert.equal(await page.locator('h1').evaluate(e => e.firstChild.textContent), 'Article');
  assert.equal(await page.locator('h1 .boba-inserted-text').count(), 1, await ui.evaluate(root => root.querySelector('#log').textContent));
  assert.equal(await page.locator('h1 .boba-inserted-text').textContent(), '繁體中文對照');
  assert.equal(await page.locator('h1 .boba-inserted-text').getAttribute('lang'), 'zh-Hant-TW');
  assert.equal(await page.locator('h1 .boba-inserted-text').evaluate(e => getComputedStyle(e).color), 'rgb(255, 0, 0)');
  const successful = await ui.evaluate(root => [...root.querySelectorAll('#progress-history [data-state="succeeded"]')].map(e => e.textContent));
  assert.ok(successful.some(text => text.includes('read_text')));
  assert.ok(successful.some(text => text.includes('insert_text')));
  assert.ok(successful.some(text => text.includes('verify_dom')));
});

test('Chromium snippet reports popup blocking and COOP restrictions', { timeout: 90000 }, async t => {
  const base = await fixture(t);
  const site = await target(t);
  const snippet = await (await fetch(base + '/devtools/boba-snippet.js')).text();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(site);
  await page.evaluate(() => { window.testOpen = window.open; window.open = () => null; });
  await page.evaluate(snippet);
  assert.equal(context.pages().length, 1);
  await page.getByRole('button', { name: 'Open Boba DevTools controller' }).waitFor();
  await page.evaluate(() => { window.open = window.testOpen; });
  const popupReady = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open Boba DevTools controller' }).click();
  const popup = await popupReady;
  await popup.locator('#connect:enabled').waitFor();
  await popup.close();
  await page.waitForFunction(() => !window.__bobaDevtools);

  await page.goto(site + '/coop');
  const isolatedReady = page.waitForEvent('popup');
  await page.evaluate(snippet);
  const isolated = await isolatedReady;
  await isolated.waitForLoadState();
  assert.ok((await isolated.locator('#connection').textContent()).includes('COOP'));
  assert.equal(await isolated.locator('#connect').isDisabled(), true);
});
