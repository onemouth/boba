const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { Agent, ProgressLedger } = require('../userscript/boba.user.js');
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = calls => ({ choices: [{ finish_reason: calls?.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls?.length ? null : 'Done', ...(calls?.length ? { tool_calls: calls } : {}) } }] });

test('edit/bash acknowledgements retain artifacts without putting text, commands or output into progress', async () => {
  let step = 0;
  const agent = new Agent({ request: async () => step++ ? reply() : reply([
    call('edit', 'edit_file', { path: 'output/a', old_text: 'PRIVATE_OLD', new_text: 'PRIVATE_NEW' }),
    call('bash', 'bash', { command: 'PRIVATE_COMMAND', timeout: 5 }),
  ]), execute: async name => name === 'edit_file' ? { edited: 'output/a' } : { output: 'PRIVATE_OUTPUT', exit_code: 0, truncated: false, timed_out: false, cancelled: false } });
  await agent.run('Work');
  const snapshot = agent.ledger.snapshot();
  assert.equal(snapshot.counts.succeeded, 2);
  assert.equal(snapshot.artifacts[0].path, 'output/a');
  for (const secret of ['PRIVATE_OLD', 'PRIVATE_NEW', 'PRIVATE_COMMAND', 'PRIVATE_OUTPUT']) assert.ok(!JSON.stringify(snapshot).includes(secret));
});

test('nonzero shell preserves diagnostic output, marks partial effects uncertain, and blocks conflicting workspace mutations', async () => {
  const executed = [];
  let step = 0;
  const responses = [reply([call('bash', 'bash', { command: 'write something; exit 2' })]), reply([
    call('edit', 'edit_file', { path: 'output/a', old_text: 'a', new_text: 'b' }),
    call('other-shell', 'bash', { command: 'a different command' }),
    call('read', 'read_file', { path: 'output/a' }),
  ]), reply()];
  const agent = new Agent({ request: async (_, body) => {
    if (step === 1) { const result = JSON.parse(body.messages.at(-1).content); assert.equal(result.output, 'useful diagnostic'); assert.equal(result.execution_status, 'uncertain'); }
    return responses[step++];
  }, execute: async name => { executed.push(name); return name === 'bash' ? { exit_code: 2, output: 'useful diagnostic' } : { content: 'inspect effects' }; } });
  await agent.run('Work');
  assert.deepEqual(executed, ['bash', 'read_file']);
  assert.deepEqual(agent.ledger.snapshot().entries.filter(e => e.kind === 'tool').map(e => e.status), ['uncertain', 'not_executed', 'not_executed', 'succeeded']);
});

test('uncertain file edits block shell commands even after page URL changes', () => {
  const ledger = new ProgressLedger();
  ledger.setContext({ url: 'https://one.test/' });
  const edit = ledger.operation(call('edit', 'edit_file', { path: 'output/a', old_text: 'a', new_text: 'b' }), 0);
  ledger.finish(edit, 'uncertain', 'Lost response');
  ledger.setContext({ url: 'https://two.test/' });
  const bash = ledger.operation(call('bash', 'bash', { command: 'printf hello' }), 1);
  assert.equal(ledger.blocked(bash), edit);
});

test('Stop aborts host shell request and leaves effects uncertain', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const agent = new Agent({ request: async () => reply([call('bash', 'bash', { command: 'sleep 30' })]), execute: (_, args, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); started();
  }) });
  const running = agent.run('Work'); await ready; agent.stop(); await running;
  assert.equal(agent.ledger.snapshot().counts.uncertain, 1);
});

test('userscript dispatches edit and bash through authenticated host HTTP, never page JS', async t => {
  const dom = new JSDOM('<!doctype html><body><p>Page</p>', { url: 'https://test.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  let root, step = 0;
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) { root = attach.call(this, options); return root; };
  window.unsafeWindow = window; window.TextEncoder = TextEncoder;
  window.GM_getValue = () => ({ server: 'http://127.0.0.1:8787', token: 'test-pairing-token-123456789' });
  for (const name of ['GM_setValue', 'GM_registerMenuCommand', 'GM_openInTab']) window[name] = () => {};
  const requests = [];
  window.GM_xmlhttpRequest = options => {
    const route = new URL(options.url).pathname, body = options.data && JSON.parse(options.data);
    requests.push({ route, body, auth: options.headers.Authorization });
    const result = route === '/api/health' ? { model: 'test/host' } : route === '/api/prompts' ? { prompts: [] }
      : route === '/api/files' ? { result: { edited: body.path } }
      : route === '/api/bash' ? { result: { exit_code: 0, output: 'done' } }
      : step++ ? reply() : reply([
        call('edit', 'edit_file', { path: 'output/a', old_text: 'before', new_text: 'after' }),
        call('bash', 'bash', { command: 'printf done', timeout: 3 }),
      ]);
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(result) }));
    return { abort() {} };
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../userscript/boba.user.js'), 'utf8'));
  root.querySelector('#input').value = 'Edit and run'; root.querySelector('#send').click();
  for (let i = 0; i < 50 && !root.querySelector('#log').textContent.includes('Done'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(requests.find(r => r.route === '/api/files').body, { operation: 'edit_file', path: 'output/a', old_text: 'before', new_text: 'after' });
  assert.deepEqual(requests.find(r => r.route === '/api/bash').body, { command: 'printf done', timeout: 3 });
  assert.ok(requests.every(r => r.auth === 'Bearer test-pairing-token-123456789'));
  assert.ok(root.querySelector('#progress-history').textContent.includes('bash · succeeded'));
});
