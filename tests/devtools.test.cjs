const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MessageChannel } = require('node:worker_threads');
const { createBobaPeer } = require('../devtools/bridge.js');

function peers(t, execute, options = {}) {
  const channel = new MessageChannel();
  const client = createBobaPeer(channel.port1, options);
  const server = createBobaPeer(channel.port2, { execute });
  t.after(() => { client.close(); server.close(); });
  return { client, server };
}

test('DevTools RPC executes page tools and propagates errors', async t => {
  const { client } = peers(t, async (method, args) => {
    if (method === 'inspect_page') return { title: 'Target', args };
    throw new Error('Unsupported page tool');
  });
  assert.deepEqual(await client.call('inspect_page', { frame: '#book' }), { title: 'Target', args: { frame: '#book' } });
  await assert.rejects(client.call('read_file', { path: '../secret' }), /Unsupported page tool/);
});

test('DevTools RPC rejects oversized results', async t => {
  const { client } = peers(t, () => 'x'.repeat(100001));
  await assert.rejects(client.call('inspect_page'), /size limit/);
});

test('DevTools Stop cancels a pending tool and aborts the remote signal', async t => {
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let notifyCancelled;
  const cancelled = new Promise(resolve => { notifyCancelled = resolve; });
  const { client } = peers(t, async (_, __, signal) => {
    notifyStarted();
    await new Promise(resolve => signal.addEventListener('abort', () => { notifyCancelled(); resolve(); }, { once: true }));
    return 'late';
  });
  const controller = new AbortController();
  const result = client.call('execute_javascript', {}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  await cancelled;
});

test('DevTools disconnect rejects in-flight and future requests', async t => {
  const { client, server } = peers(t, () => new Promise(() => {}));
  const result = client.call('inspect_page');
  server.close('Target reloaded');
  await assert.rejects(result, /disconnected/);
  await assert.rejects(client.call('inspect_page'), /disconnected/);
});

test('a page cannot invoke controller/host capabilities through the RPC port', async t => {
  const channel = new MessageChannel();
  let closed = false;
  const client = createBobaPeer(channel.port1, { onDisconnect: () => { closed = true; }, timeoutMs: 10 });
  t.after(() => { client.close(); channel.port2.close(); });
  for (const method of ['write_file', 'edit_file', 'bash']) channel.port2.postMessage({ type: 'call', id: 'attacker-' + method, method, args: { path: 'owned', content: 'bad', command: 'bad' } });
  channel.port2.postMessage({ type: 'result', id: 'unrequested', ok: true, value: 'forged' });
  await assert.rejects(client.call('inspect_page'), /timed out/);
  assert.equal(closed, false);
});
