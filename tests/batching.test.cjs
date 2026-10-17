const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../userscript/boba.user.js');

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls = [], finish_reason = calls.length ? 'tool_calls' : 'stop') => ({ choices: [{ finish_reason, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] });

test('length discards the entire incomplete completion and retries a smaller complete batch', async () => {
  let requests = 0;
  const executions = [], events = [];
  const agent = new Agent({
    request: async (_, body) => {
      requests++;
      if (requests === 1) return reply('PARTIAL PROSE DO NOT SHOW', [
        call('possibly-complete', 'write_file', { path: 'output/unsafe', content: 'not accepted' }),
        { id: 'broken', function: { name: 'execute_javascript', arguments: '{"code":"unfinished' } },
      ], 'length');
      if (requests === 2) {
        assert.ok(body.messages[0].content.includes('Output recovery:'));
        assert.ok(!body.messages.some(m => m.content === 'PARTIAL PROSE DO NOT SHOW'));
        assert.equal(body.messages.filter(m => m.role === 'user').length, 1);
        return reply(null, [call('small', 'write_file', { path: 'output/part-001.md', content: 'Small complete batch' })]);
      }
      return reply('Done');
    },
    execute: async (name, args) => { executions.push([name, args]); return { written: args.path }; },
    onEvent: (kind, value) => events.push([kind, value]),
  });
  const originalSystem = agent.messages[0].content;
  await agent.run('Generate a long result');
  assert.equal(requests, 3);
  assert.deepEqual(executions, [['write_file', { path: 'output/part-001.md', content: 'Small complete batch' }]]);
  assert.equal(agent.messages[0].content, originalSystem);
  assert.equal(agent.messages.filter(m => m.role === 'tool').length, 1);
  assert.ok(!events.some(([kind, value]) => kind === 'assistant' && value.includes('PARTIAL')));
  assert.ok(events.some(([kind]) => kind === 'notice'));
});

test('length recovery never re-executes already confirmed batches', async () => {
  let requests = 0;
  const paths = [];
  const first = call('first', 'write_file', { path: 'output/part-001.md', content: 'One' });
  const agent = new Agent({
    request: async (_, body) => {
      requests++;
      if (requests === 1) return reply(null, [first]);
      if (requests === 2) return reply(null, [first], 'length');
      if (requests === 3) {
        assert.equal(body.messages.at(-1).tool_call_id, 'first');
        assert.equal(body.messages.filter(m => m.role === 'tool').length, 1);
        return reply(null, [call('second', 'write_file', { path: 'output/part-002.md', content: 'Two' })]);
      }
      return reply('Done');
    },
    execute: async (_, args) => { paths.push(args.path); return 'saved'; },
  });
  await agent.run('Write in batches');
  assert.deepEqual(paths, ['output/part-001.md', 'output/part-002.md']);
});

test('repeated length is bounded to two retries with no partial history or tool execution', async () => {
  let requests = 0;
  const errors = [];
  const agent = new Agent({
    request: async () => { requests++; return reply('partial', [call('partial', 'click', { selector: '#submit' })], 'length'); },
    execute: async () => assert.fail('truncated calls must never execute'),
    onEvent: (kind, value) => { if (kind === 'error') errors.push(value); },
  });
  await agent.run('Too large');
  assert.equal(requests, 3);
  assert.equal(agent.messages.length, 2);
  assert.ok(errors[0].includes('2 smaller-batch retries'));
  assert.equal(agent.controller, null);
});

test('Stop during truncation recovery prevents another model request', async () => {
  let requests = 0;
  const agent = new Agent({
    request: async () => { requests++; return reply('partial', [], 'length'); },
    execute: async () => assert.fail('no tools'),
    onEvent: kind => { if (kind === 'notice') agent.stop(); },
  });
  await agent.run('Large task');
  assert.equal(requests, 1);
  assert.equal(agent.controller, null);
});

test('checkpoint automatically continues generic prose in complete chunks without page/host calls', async () => {
  let requests = 0;
  const chunks = [];
  const agent = new Agent({
    request: async (_, body) => {
      requests++;
      if (requests <= 2) return reply(`Chunk ${requests}`, [call(`checkpoint-${requests}`, 'checkpoint', { progress: `Finished ${requests}`, next: `Produce chunk ${requests + 1}` })]);
      assert.equal(body.messages.filter(m => m.role === 'tool').length, 2);
      assert.equal(JSON.parse(body.messages.at(-1).content).continue, true);
      return reply('Chunk 3. Done.');
    },
    execute: async () => assert.fail('checkpoint is internal, not a host/page tool'),
    onEvent: (kind, value) => { if (kind === 'assistant') chunks.push(value); },
  });
  await agent.run('Produce a long report in small chunks');
  assert.deepEqual(chunks, ['Chunk 1', 'Chunk 2', 'Chunk 3. Done.']);
  assert.equal(requests, 3);
});

test('checkpoint obeys step limits and can be continued with a follow-up', async () => {
  let requests = 0;
  const errors = [];
  const agent = new Agent({ maxSteps: 2,
    request: async () => ++requests <= 2 ? reply(null, [call(String(requests), 'checkpoint', { progress: `Batch ${requests}`, next: 'Next batch' })]) : reply('Done'),
    execute: async () => assert.fail('no external tool'),
    onEvent: (kind, value) => { if (kind === 'error') errors.push(value); },
  });
  await agent.run('Many batches');
  assert.equal(requests, 2);
  assert.ok(errors[0].includes('2 model steps'));
  await agent.run('Continue');
  assert.equal(agent.messages.at(-1).content, 'Done');
});
