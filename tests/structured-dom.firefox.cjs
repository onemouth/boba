// Real Firefox strict CSP + same-origin iframe; only GM/network/model are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { firefox } = require('@playwright/test');

test('Firefox strict CSP: complete bilingual iframe flow and cleanup without Function/HTML injection', async t => {
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const source = await fs.readFile(path.join(__dirname, '../userscript/boba.user.js'), 'utf8');
  const policy = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'";
  await page.route('http://boba-structured.local/**', route => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/boba.js') return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: source });
    if (name === '/setup.js') return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: `
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); if (this.localName === 'boba-panel') window.testRoot = root; return root; };
      window.unsafeWindow = window;
      window.GM_getValue = () => ({server:'http://127.0.0.1:8787',token:'test-pairing-token-123456789',shortcut:'Alt+Shift+B'});
      window.GM_setValue = () => {};
      window.GM_registerMenuCommand = () => {};
      window.GM_openInTab = () => {};
      let modelCalls = 0, ids = [], allIds = [];
      window.testResults = [];
      window.GM_xmlhttpRequest = options => {
        const route = new URL(options.url).pathname;
        let result;
        if (route === '/api/health') result = {model:'test/structured'};
        else if (route === '/api/prompts') result = {prompts:[]};
        else {
          const body = JSON.parse(options.data), last = body.messages.at(-1);
          if (last.role === 'tool') {
            const value = JSON.parse(last.content);
            window.testResults.push(value);
            if (value.items?.[0]?.complete !== undefined) { allIds = value.items.map(i=>i.source_id); ids = value.items.filter(i=>i.text.trim()).map(i=>i.source_id); }
          }
          const calls = [
            ['execute_javascript',{code:'return document.title'}],
            ['read_text',{selector:'article',frame:'#reader'}],
            ['insert_text',{items:ids.map((id,i)=>({source_id:id,text:i===0?'第一行\\n第二行':'第二段譯文',lang:'zh-Hant-TW'}))}],
            ['set_style',{source_ids:ids,properties:{color:'red','line-height':'1.8'}}],
            ['verify_dom',{source_ids:allIds}],
            null,
            ['remove_inserted',{source_ids:allIds}],
            null,
          ];
          const next = calls[modelCalls++];
          const message = next ? {role:'assistant',content:null,tool_calls:[{id:'call-'+modelCalls,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]} : {role:'assistant',content:'Done. DOM checks only; no screenshot was taken.'};
          result = {choices:[{finish_reason:next?'tool_calls':'stop',message}]};
        }
        queueMicrotask(()=>options.onload({status:200,responseText:JSON.stringify(result)}));
        return {abort(){options.onabort();}};
      };
    ` });
    const body = name === '/content' ? '<!doctype html><article><p id="one">First line<br>Second line</p><p id="two">Another paragraph.</p><p id="empty"></p></article>'
      : '<!doctype html><title>Structured reader</title><iframe id="reader" src="/content"></iframe><script src="/setup.js"></script><script src="/boba.js"></script>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': policy }, body });
  });
  await page.goto('http://boba-structured.local/');
  await page.keyboard.press('Alt+Shift+B');
  const ui = await page.evaluateHandle(() => window.testRoot);
  const run = async text => {
    await ui.evaluate((root, value) => { root.querySelector('#input').value = value; root.querySelector('#send').click(); }, text);
    await page.waitForFunction(() => !testRoot.querySelector('#send').disabled && testRoot.querySelector('#status').textContent === 'Ready');
  };
  await run('Make a bilingual reader using structured tools.');
  const frame = page.frameLocator('#reader');
  assert.equal(await frame.locator('.boba-inserted-text').count(), 2);
  assert.equal(await frame.locator('#one').evaluate(e => e.firstChild.textContent), 'First line');
  assert.equal(await frame.locator('#one br').count(), 1);
  assert.equal(await frame.locator('#one .boba-inserted-text').textContent(), '第一行\n第二行');
  assert.equal(await frame.locator('#one .boba-inserted-text').evaluate(e => getComputedStyle(e).color), 'rgb(255, 0, 0)');
  const results = await page.evaluate(() => window.testResults);
  const verified = results.find(result => result.verification);
  assert.equal(verified.originals_unchanged, true);
  assert.equal(verified.all_paired, true);
  assert.equal(verified.items[2].empty_source, true);
  const states = await ui.evaluate(root => [...root.querySelectorAll('#progress-history li[data-state]')].map(e => ({text:e.textContent,state:e.getAttribute('data-state')})));
  assert.equal(states.find(entry => entry.text.includes('execute_javascript')).state, 'not_executed');
  assert.ok(!states.some(entry => entry.state === 'uncertain'));
  await run('Remove the inserted translations.');
  assert.equal(await frame.locator('.boba-inserted-text').count(), 0);
  assert.equal(await frame.locator('#one').textContent(), 'First lineSecond line');
});
