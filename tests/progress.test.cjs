const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Agent, ProgressLedger } = require('../userscript/boba.user.js');

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (calls = [], text = calls.length ? null : 'Done', reason = calls.length ? 'tool_calls' : 'stop') => ({ choices: [{ finish_reason: reason, message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) } }] });
const tools = agent => agent.ledger.snapshot().entries.filter(entry => entry.kind === 'tool');

function scripted(responses, execute, options = {}) {
  let requests = 0;
  const bodies = [];
  const agent = new Agent({ ...options, execute,
    request: async (_, body) => {
      bodies.push(JSON.parse(JSON.stringify(body)));
      const response = responses[requests++];
      return typeof response === 'function' ? response(body) : response || reply();
    },
  });
  return { agent, bodies };
}

test('ledger records tool acknowledgements/artifacts, not raw code, values, or file bodies', async () => {
  const fileContent = 'PRIVATE_FILE_BODY';
  const code = 'PRIVATE_JAVASCRIPT_SOURCE';
  const value = 'PRIVATE_TYPED_VALUE';
  const { agent } = scripted([reply([
    call('a', 'write_file', { path: 'output/part-001.md', content: fileContent }),
    call('b', 'type', { selector: '#name', text: value }),
    call('c', 'execute_javascript', { code }),
  ])], async (name, args) => name === 'write_file' ? { written: args.path } : { returned: true });
  await agent.run('Produce a report');
  const snapshot = agent.ledger.snapshot();
  assert.equal(snapshot.counts.succeeded, 3);
  assert.equal(snapshot.artifacts[0].path, 'output/part-001.md');
  assert.ok(tools(agent).find(entry => entry.tool === 'execute_javascript').note.includes('not independently verified'));
  const serialized = JSON.stringify(snapshot);
  for (const secret of [fileContent, code, value]) assert.ok(!serialized.includes(secret));
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.taskCompleted, undefined);
});

test('checkpoint is an unverified model claim, and fabricated evidence IDs do not promote it', async () => {
  const { agent } = scripted([
    reply([call('fake', 'checkpoint', { progress: 'Everything completed', next: 'Next', operation_ids: ['op-does-not-exist'] })]),
    reply([call('claim', 'checkpoint', { progress: 'Everything completed', next: 'Next' })]),
  ], async () => assert.fail('internal checkpoint must not call a host/page tool'));
  await agent.run('Work');
  const entries = tools(agent);
  assert.equal(entries[0].status, 'not_executed');
  assert.equal(entries[1].status, 'reported');
  assert.equal(agent.ledger.cursor.source, 'model_report_unverified');
  assert.equal(agent.ledger.snapshot().counts.succeeded || 0, 0);
});

test('checkpoint can link acknowledged actions without asserting batch/task verification', async () => {
  const { agent } = scripted([
    reply([call('write', 'write_file', { path: 'output/a.md', content: 'A' })]),
    reply([call('progress', 'checkpoint', { progress: 'Saved batch 1', next: 'Batch 2', batch_id: 'one', operation_ids: ['op-1'] })]),
  ], async (_, args) => ({ written: args.path }));
  await agent.run('Save numbered parts');
  assert.deepEqual(agent.ledger.cursor.operation_ids, ['op-1']);
  assert.equal(agent.ledger.cursor.batch, 'one');
  assert.equal(agent.ledger.snapshot().counts.succeeded, 1);
  assert.equal(agent.ledger.snapshot().counts.reported, 1);
});

test('mutations failing after dispatch are uncertain; read errors are failed; preflight errors did not execute', async () => {
  const { agent } = scripted([
    reply([
      call('partial', 'execute_javascript', { code: 'changeThenThrow()' }),
      call('read', 'query_elements', { selector: '#missing' }),
      call('invalid', 'write_file', { path: 'output/never-written' }),
    ]),
  ], async () => { throw new Error('Tool error'); });
  await agent.run('Work');
  assert.deepEqual(tools(agent).map(entry => entry.status), ['uncertain', 'failed', 'not_executed']);
  const results = agent.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(results[0].execution_status, 'uncertain');
  assert.equal(results[0].inspect_before_retry, true);
  assert.equal(results[2].execution_status, 'not_executed');
});

test('an error-shaped resolved result is not counted as a successful mutation', async () => {
  const { agent } = scripted([reply([call('a', 'write_file', { path: 'a', content: 'A' })])], async () => ({ error: 'No acknowledgement' }));
  await agent.run('Write');
  assert.equal(tools(agent)[0].status, 'uncertain');
  assert.equal(agent.ledger.artifacts.length, 0);
});

test('exact uncertain mutation repeats are blocked until explicit user review, retaining original failure', async () => {
  let executions = 0;
  const mutation = call('mutate', 'click', { selector: '#submit' });
  const { agent, bodies } = scripted([
    reply([mutation]), reply(),
    reply([mutation]), reply(),
    reply([mutation]), reply(),
  ], async () => { if (++executions === 1) throw new Error('Connection lost after dispatch'); return { clicked: '#submit' }; });
  await agent.run('Click');
  const first = tools(agent)[0];
  await agent.run('Continue');
  assert.equal(executions, 1);
  assert.equal(tools(agent)[1].status, 'not_executed');
  assert.ok(bodies[2].messages[0].content.includes(first.id));
  assert.ok(bodies[2].messages[0].content.includes('uncertain'));
  agent.reviewOperation(first.id, 'not_executed');
  await agent.run('I verified no submission happened; try now');
  assert.equal(executions, 2);
  const reviewed = agent.ledger.snapshot().entries.find(entry => entry.id === first.id);
  assert.equal(reviewed.status, 'uncertain');
  assert.deepEqual([reviewed.review.status, reviewed.review.source], ['not_executed', 'user']);
});

test('Stop distinguishes an in-flight mutation from later undispatched operations, with valid repair messages', async () => {
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const { agent } = scripted([reply([
    call('a', 'execute_javascript', { code: 'slowChange()' }),
    call('b', 'click', { selector: '#submit' }),
  ])], () => { start(); return new Promise(() => {}); });
  const running = agent.run('Work');
  await started;
  agent.stop();
  await running;
  assert.deepEqual(tools(agent).map(entry => entry.status), ['uncertain', 'not_executed']);
  const results = agent.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.deepEqual(results.map(result => result.execution_status), ['uncertain', 'not_executed']);
  assert.equal(agent.ledger.snapshot().state, 'stopped');
});

test('Stop received at the running notification still prevents dispatch', async () => {
  let agent;
  ({ agent } = scripted([reply([call('a', 'click', { selector: '#submit' })])], async () => assert.fail('dispatch after Stop'), {
    onEvent(kind, snapshot) { if (kind === 'progress' && snapshot.entries.some(entry => entry.status === 'running')) agent.stop(); },
  }));
  await agent.run('Work');
  assert.equal(tools(agent)[0].status, 'not_executed');
});

test('truncated output records a safe failure but does not log or dispatch incomplete candidate tools', async () => {
  const { agent, bodies } = scripted([
    reply([call('broken', 'execute_javascript', { code: 'SECRET_PARTIAL_SOURCE' })], 'SECRET_PARTIAL_TEXT', 'length'),
    reply(),
  ], async () => assert.fail('truncated tools must not execute'));
  await agent.run('Work');
  const snapshot = agent.ledger.snapshot();
  assert.ok(snapshot.entries.some(entry => entry.code === 'output_limit'));
  assert.equal(tools(agent).length, 0);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET_PARTIAL'));
  assert.ok(bodies[1].messages[0].content.includes('None of its tools were dispatched'));
});

test('source changes stale the model cursor and block changes until inspection in a new response', async () => {
  const first = { url: 'https://example.com/page?chapter=1', title: 'One' };
  let current = first;
  let changes = 0;
  const { agent } = scripted([
    reply([call('checkpoint', 'checkpoint', { progress: 'Batch 1', next: 'Batch 2', batch_id: '2' })]), reply(),
    reply([call('too-soon', 'type', { selector: '#name', text: 'A' })]),
    reply([call('inspect', 'inspect_page')]),
    reply([call('now', 'type', { selector: '#name', text: 'A' })]), reply(),
  ], async name => name === 'inspect_page' ? current : (++changes, { typed: '#name' }), { getPageContext: () => current });
  await agent.run('Work', first);
  current = { url: 'https://example.com/page?chapter=2', title: 'Two' };
  await agent.run('Continue', current);
  assert.equal(changes, 1);
  assert.equal(agent.ledger.cursor.stale, true);
  assert.equal(tools(agent).find(entry => entry.callId === 'too-soon').status, 'not_executed');
  assert.ok(!agent.ledger.modelNote().includes('?chapter='));
});

test('workspace mutation replay guard survives a target URL change', async () => {
  const ledger = new ProgressLedger();
  const mutation = call('write', 'write_file', { path: 'output/a.md', content: 'A' });
  ledger.beginRun({ url: 'https://example.com/a' }, 'Work');
  const first = ledger.operation(mutation, 1);
  ledger.finish(first, 'uncertain', 'Network failed');
  ledger.setContext({ url: 'https://example.com/b' });
  const retry = ledger.operation(mutation, 2);
  assert.equal(ledger.blocked(retry).id, first.id);
  const overwrite = ledger.operation(call('new', 'write_file', { path: 'output/a.md', content: 'Different content' }), 3);
  assert.equal(ledger.blocked(overwrite).id, first.id);
  const remove = ledger.operation(call('trash', 'trash_file', { path: 'output/a.md' }), 4);
  assert.equal(ledger.blocked(remove).id, first.id);
});

test('bounded history retains unresolved operations, aggregate counts and safe summaries', () => {
  const ledger = new ProgressLedger({ maxEntries: 3 });
  const uncertain = ledger.operation(call('a', 'execute_javascript', { code: 'DO_NOT_LOG' }), 1);
  ledger.finish(uncertain, 'uncertain', 'password=secret api_key=secret Bearer secret');
  for (let index = 0; index < 8; index++) {
    const entry = ledger.operation(call(String(index), 'inspect_page'), index + 2);
    ledger.acknowledge(entry, {}, {});
  }
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.entries.length, 3);
  assert.ok(snapshot.entries.some(entry => entry.id === uncertain.id));
  assert.equal(snapshot.counts.succeeded, 8);
  assert.equal(snapshot.counts.uncertain, 1);
  assert.equal(snapshot.dropped, 6);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
  assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_LOG'));
  snapshot.entries[0].status = 'succeeded';
  assert.equal(ledger.entries[0].status, 'uncertain');
});

test('a full protected ledger stops before dispatch and marks unscheduled calls not executed', async () => {
  let executions = 0;
  const { agent } = scripted([
    reply([call('a', 'execute_javascript', { code: 'fail()' })]),
    reply([call('b', 'click', { selector: '#submit' })]),
  ], async () => { executions++; throw new Error('After dispatch'); }, { maxLedgerEntries: 1 });
  await agent.run('Work');
  assert.equal(executions, 1);
  assert.equal(agent.ledger.snapshot().state, 'paused');
  const last = JSON.parse(agent.messages.at(-1).content);
  assert.equal(last.execution_status, 'not_executed');
});

test('model projection can omit old turns without deleting the local transcript or ledger facts', async () => {
  let requests = 0;
  const agent = new Agent({
    request: async (_, body) => {
      requests++;
      if (requests === 1) return reply([call('save', 'write_file', { path: 'output/kept.md', content: 'A' })]);
      if (requests === 3) {
        assert.equal(body.messages.filter(message => message.role === 'user').length, 1);
        assert.ok(body.messages[0].content.includes('output/kept.md'));
        assert.ok(body.messages[0].content.includes('initial_instruction_excerpt'));
      }
      return reply();
    }, execute: async (_, args) => ({ written: args.path }),
  });
  await agent.run('Initial task ' + 'x'.repeat(1500000));
  await agent.run('Continue ' + 'y'.repeat(1500000));
  assert.equal(agent.messages.filter(message => message.role === 'user').length, 2);
  assert.equal(agent.ledger.artifacts[0].path, 'output/kept.md');
});

test('projection respects server message limits while retaining a bounded local transcript', async () => {
  const agent = new Agent({ request: async (_, body) => { assert.ok(body.messages.length <= 400); return reply(); }, execute: async () => {} });
  for (let index = 0; index < 250; index++) agent.messages.push({ role: 'user', content: 'Old request' }, { role: 'assistant', content: 'Old response' });
  await agent.run('Latest instruction');
  assert.ok(agent.messages.length > 400);
});

test('New clears progress/claims/transcript but is not an undo operation', async () => {
  const { agent } = scripted([reply([call('a', 'write_file', { path: 'output/a', content: 'A' })])], async (_, args) => ({ written: args.path }));
  await agent.run('Work');
  agent.reset();
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.ledger.entries.length, 0);
  assert.equal(agent.ledger.artifacts.length, 0);
  assert.equal(agent.ledger.state, 'idle');
});
