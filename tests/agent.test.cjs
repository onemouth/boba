const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { Agent, TOOLS, createPageTools, bounded, trimContext } = require('../userscript/boba.user.js');

const assistant = (content, calls = []) => ({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] });
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('tool calling loop and follow-up preserve valid history', async () => {
  const events = [], executions = [];
  let requests = 0;
  const agent = new Agent({
    request: async (_, body) => {
      assert.equal(body.tools, TOOLS);
      requests++;
      if (requests === 1) return assistant('Checking', [call('a', 'inspect_page')]);
      if (requests === 2) {
        assert.equal(body.messages.at(-1).tool_call_id, 'a');
        assert.deepEqual(JSON.parse(body.messages.at(-1).content), { title: 'Test' });
        return assistant('Done');
      }
      assert.equal(body.messages.filter(m => m.role === 'user').length, 2);
      return assistant('Refined');
    },
    execute: async name => { executions.push(name); return { title: 'Test' }; },
    onEvent: (kind, value) => events.push([kind, value]),
  });
  await agent.run('inspect');
  await agent.run('refine');
  assert.deepEqual(executions, ['inspect_page']);
  assert.ok(events.some(([kind, value]) => kind === 'assistant' && value === 'Refined'));
  assert.equal(agent.controller, null);
});

test('malformed arguments and unknown tools become tool errors without execution', async () => {
  let count = 0;
  const agent = new Agent({
    request: async () => count++ ? assistant('Recovered') : assistant(null, [
      { ...call('a', 'click'), function: { name: 'click', arguments: '{broken' } },
      call('b', 'shell'),
    ]),
    execute: async () => assert.fail('must not execute'),
  });
  await agent.run('go');
  const results = agent.messages.filter(m => m.role === 'tool');
  assert.equal(results.length, 2);
  assert.ok(results.every(m => JSON.parse(m.content).error));
});

test('Stop aborts requests and prevents later tools while repairing history', async () => {
  const started = deferred();
  const waiting = deferred();
  const executed = [];
  let requestCount = 0;
  const agent = new Agent({
    request: async () => requestCount++ ? assistant('After stop') : assistant(null, [call('a', 'inspect_page'), call('b', 'click', { selector: '#submit' })]),
    execute: async name => { executed.push(name); started.resolve(); return waiting.promise; },
  });
  const run = agent.run('go');
  await started.promise;
  agent.stop();
  await run;
  assert.deepEqual(executed, ['inspect_page']);
  assert.equal(agent.messages.filter(m => m.role === 'tool').length, 2);
  assert.equal(agent.controller, null);
  waiting.resolve('late result');
  await agent.run('follow up');
  assert.equal(agent.messages.at(-1).content, 'After stop');
});

test('Stop during model request executes no returned calls', async () => {
  const started = deferred();
  let aborted = false;
  const agent = new Agent({
    request: async (_, __, signal) => {
      started.resolve();
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return assistant(null, [call('a', 'click')]);
    },
    execute: async () => assert.fail('must not execute after cancellation'),
  });
  const run = agent.run('go');
  await started.promise;
  agent.stop();
  await run;
  assert.equal(aborted, true);
});

test('step limit bounds model calls and leaves history valid', async () => {
  let requests = 0;
  const events = [];
  const agent = new Agent({ maxSteps: 2,
    request: async () => assistant(null, [call(String(requests++), 'inspect_page')]),
    execute: async () => 'ok',
    onEvent: (kind, value) => events.push([kind, value]),
  });
  await agent.run('loop');
  assert.equal(requests, 2);
  assert.ok(events.some(([kind, value]) => kind === 'error' && value.includes('2 model steps')));
  assert.equal(agent.messages.at(-1).role, 'tool');
});

test('context trimming removes complete old turns and bounds oversized current task', () => {
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'x'.repeat(2800000) },
    { role: 'assistant', tool_calls: [call('a', 'inspect_page')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'assistant', content: 'done' }, { role: 'user', content: 'latest' }];
  trimContext(messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, 'latest');
  assert.throws(() => trimContext([{ role: 'system', content: 's' }, { role: 'user', content: 'x'.repeat(2800000) }]), /context limit/);
  assert.ok(JSON.parse(bounded({ big: 'x'.repeat(30000) })).truncated);
});

function testPage() {
  return new JSDOM(`<!doctype html><html lang="en"><head><title>Test page</title></head><body>
    <main id="main"><p>Hello world</p><aside id="sidebar">Side</aside>
    <form id="form"><input id="name"><input id="password" type="password" value="sensitive"><textarea id="notes"></textarea>
    <select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select><button id="submit">Submit</button></form>
    <a href="/one">One</a><a href="https://example.org/two">Two</a><div hidden id="hidden" data-secret="test">Hidden text</div></main>
    </body></html>`, { url: 'https://example.com/test', runScripts: 'dangerously' });
}

test('inspect/query read form values, hidden DOM, attributes, and paginate', async t => {
  const dom = testPage(); t.after(() => dom.window.close());
  const execute = createPageTools(dom.window, dom.window.document);
  const result = await execute('inspect_page', {});
  assert.equal(result.title, 'Test page');
  assert.equal(result.forms.find(e => e.selector === '#password').value, 'sensitive');
  assert.equal(result.links.length, 2);
  const hidden = await execute('query_elements', { selector: '#hidden' });
  assert.equal(hidden.elements[0].text, 'Hidden text');
  assert.equal(hidden.elements[0].attributes['data-secret'], 'test');
  const page = await execute('query_elements', { selector: 'a', offset: 1, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.elements.length, 1);
  assert.equal(page.elements[0].text, 'Two');
});

test('type uses native setters/events and obeys no-submit when filling', async t => {
  const dom = testPage(); t.after(() => dom.window.close());
  const document = dom.window.document;
  const execute = createPageTools(dom.window, document);
  let submissions = 0, changes = 0;
  document.querySelector('#form').addEventListener('submit', event => { event.preventDefault(); submissions++; });
  document.querySelector('#name').addEventListener('input', () => changes++);
  await execute('type', { selector: '#name', text: 'Boba' });
  await execute('type', { selector: '#notes', text: 'Test notes' });
  await execute('type', { selector: '#select', text: 'b' });
  assert.equal(document.querySelector('#name').value, 'Boba');
  assert.equal(document.querySelector('#select').value, 'b');
  assert.equal(changes, 1);
  assert.equal(submissions, 0);
  await assert.rejects(execute('click', { selector: 'input' }), /Expected one/);
});

test('JavaScript modifies page in page realm without access to private lexical variables', async t => {
  const dom = testPage(); t.after(() => dom.window.close());
  const execute = createPageTools(dom.window, dom.window.document);
  const result = await execute('execute_javascript', { code: `document.querySelector('#sidebar').remove(); document.querySelector('#main').style.maxWidth = '900px'; return { title: document.title, secret: typeof settings, bridge: typeof request };` });
  assert.equal(result.title, 'Test page');
  assert.equal(result.secret, 'undefined');
  assert.equal(result.bridge, 'undefined');
  assert.equal(dom.window.document.querySelector('#sidebar'), null);
});

test('closed panel is excluded from page tools and its ancestors cannot be clicked', async t => {
  const dom = testPage(); t.after(() => dom.window.close());
  const host = dom.window.document.createElement('boba-panel');
  host.id = 'boba';
  host.attachShadow({ mode: 'closed' }).innerHTML = '<input value="private-token">';
  dom.window.document.body.append(host);
  const execute = createPageTools(dom.window, dom.window.document, host);
  const query = await execute('query_elements', { selector: 'boba-panel' });
  assert.equal(query.total, 0);
  await assert.rejects(execute('click', { selector: '#boba' }), /Boba panel/);
  const result = await execute('inspect_page', {});
  assert.ok(!JSON.stringify(result).includes('private-token'));
});

test('full UI boot, shortcut, settings, prompt loading and model/tool follow-up', async t => {
  const dom = testPage(); t.after(() => dom.window.close());
  const { window } = dom;
  let root;
  const original = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { root = original.call(this, options); return root; };
  const stored = { server: 'http://127.0.0.1:8787', token: 'test-pairing-token-123456789' };
  const requests = [];
  let modelCalls = 0;
  window.unsafeWindow = window;
  window.TextEncoder = TextEncoder;
  window.GM_getValue = () => stored;
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = () => {};
  window.GM_openInTab = () => {};
  window.GM_xmlhttpRequest = options => {
    requests.push(options);
    let result;
    const route = new URL(options.url).pathname;
    if (route === '/api/health') result = { model: 'test/model' };
    else if (route === '/api/prompts') result = { prompts: [{ name: 'translate', path: 'prompts/translate.md' }] };
    else if (route === '/api/files') result = { result: 'Translate this page to Traditional Chinese' };
    else if (route === '/v1/chat/completions') result = modelCalls++ === 0 ? assistant(null, [call('a', 'type', { selector: '#name', text: 'Boba' })]) : assistant('Done');
    else assert.fail(`Unexpected route ${route}`);
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(result) }));
    return { abort() {} };
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../userscript/boba.user.js'), 'utf8'));
  const host = window.document.querySelector('boba-panel');
  assert.equal(host.shadowRoot, null);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ı', code: 'KeyB', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.style.display, 'block');
  assert.equal(root.querySelector('#prompts').options.length, 2);
  root.querySelector('#input').value = '/translate keep the form intact';
  root.querySelector('#send').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(window.document.querySelector('#name').value, 'Boba');
  assert.ok(root.querySelector('#log').textContent.includes('Done'));
  const model = requests.find(r => new URL(r.url).pathname === '/v1/chat/completions');
  assert.ok(JSON.parse(model.data).messages.at(-1).content.includes('Translate this page to Traditional Chinese'));
  assert.equal(model.headers.Authorization, `Bearer ${stored.token}`);
  assert.equal(root.querySelector('#stop').disabled, true);
});
