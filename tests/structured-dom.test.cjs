const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { Agent, ToolDispatchError, createPageTools, bounded } = require('../userscript/boba.user.js');

function fixture(t, extra = '') {
  const dom = new JSDOM(`<!doctype html><title>Text fixture</title><article id="article"><p id="one">First line<br>Second line\nThird line <a href="/link">link</a></p><p id="two">Another paragraph.</p><p id="empty"></p><p id="hidden" hidden>Hidden text</p></article><div class="boba-zh-translation" id="foreign">Not owned by Boba</div><input id="form" value="DO_NOT_TOUCH">${extra}`, {
    url: 'https://example.com/article', runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  return { dom, document, execute: createPageTools(dom.window, document) };
}
const read = (execute, args = {}) => execute('read_text', { selector: '#article', ...args });

test('read_text preserves line breaks, links, empty blocks and stable IDs without changing the page', async t => {
  const { document, execute } = fixture(t);
  const before = document.querySelector('#article').innerHTML;
  const result = await read(execute);
  assert.equal(result.total, 3);
  assert.equal(result.items[0].text, 'First line\nSecond line\nThird line link');
  assert.equal(result.items[2].text, '');
  assert.ok(result.items.every(item => item.complete));
  assert.equal(document.querySelector('#article').innerHTML, before);
  assert.equal((await read(execute)).items[0].source_id, result.items[0].source_id);
  assert.equal((await read(execute, { include_hidden: true })).total, 4);
  assert.equal((await execute('read_text', { selector: '#form', mode: 'element' })).total, 0);
});

test('read_text explicitly paginates a long paragraph with no lost characters or silent preview', async t => {
  const { document, execute } = fixture(t);
  const text = 'Line\n"quoted"\\text 繁體中文 '.repeat(2000);
  document.querySelector('#one').textContent = text;
  let offset = 0, charOffset = 0, restored = '', id;
  for (let page = 0; page < 100; page++) {
    const result = await execute('read_text', { selector: '#one', offset, char_offset: charOffset, max_chars: 1000 });
    assert.ok(bounded(result).length < 24000);
    assert.equal(JSON.parse(bounded(result)).preview, undefined);
    assert.equal(result.items.length, 1);
    id ||= result.items[0].source_id;
    assert.equal(result.items[0].source_id, id);
    restored += result.items[0].text;
    if (!result.more) break;
    offset = result.next_offset;
    charOffset = result.next_char_offset;
  }
  assert.equal(restored, text);
});

test('read_text bounds JSON escaping and has safe continuation for control-character-heavy text', async t => {
  const { document, execute } = fixture(t);
  document.querySelector('#one').textContent = '\u0001'.repeat(8000);
  const result = await execute('read_text', { selector: '#one', max_chars: 8000 });
  assert.ok(JSON.stringify(result).length < 24000);
  assert.equal(result.more, true);
  assert.equal(result.next_offset, 0);
  assert.ok(result.next_char_offset > 0);
  assert.equal(JSON.parse(bounded(result)).preview, undefined);
});

test('pure-text insertion is idempotent, preserves original nodes, and does not interpret HTML', async t => {
  const { document, execute } = fixture(t);
  const data = await read(execute);
  const id = data.items[0].source_id;
  const anchor = document.querySelector('#one a');
  const firstText = document.querySelector('#one').firstChild;
  const value = '<img src=x onerror="window.hacked=true"> & literal text';
  await execute('insert_text', { items: [{ source_id: id, text: value, lang: 'zh-Hant-TW' }] });
  const node = document.querySelector('.boba-inserted-text');
  assert.equal(node.textContent, value);
  assert.equal(node.childElementCount, 0);
  assert.equal(document.querySelector('#one img'), null);
  assert.equal(document.querySelector('#one a'), anchor);
  assert.equal(document.querySelector('#one').firstChild, firstText);
  assert.equal((await read(execute)).items[0].text, data.items[0].text);
  await execute('insert_text', { items: [{ source_id: id, text: '更新的譯文', lang: 'zh-Hant-TW' }] });
  assert.equal(document.querySelectorAll('.boba-inserted-text').length, 1);
  assert.equal(document.querySelector('.boba-inserted-text'), node);
  assert.equal(node.lang, 'zh-Hant-TW');
  const result = await execute('verify_dom', { source_ids: [id, data.items[2].source_id] });
  assert.equal(result.all_paired, true);
  assert.equal(result.items[1].empty_source, true);
});

test('a stale source invalidates a whole insertion batch before any mutation', async t => {
  const { document, execute } = fixture(t);
  const data = await read(execute);
  document.querySelector('#two').textContent = 'Changed';
  await assert.rejects(execute('insert_text', { items: data.items.slice(0, 2).map(item => ({ source_id: item.source_id, text: 'Translated' })) }), ToolDispatchError);
  assert.equal(document.querySelectorAll('.boba-inserted-text').length, 0);
});

test('reordering source elements does not mispair stable IDs; replacement/detach is refused', async t => {
  const { document, execute } = fixture(t);
  const data = await read(execute);
  const one = document.querySelector('#one');
  document.querySelector('#article').append(one);
  await execute('insert_text', { items: [{ source_id: data.items[0].source_id, text: 'Still first source' }] });
  assert.equal(one.querySelector('.boba-inserted-text').textContent, 'Still first source');
  const second = document.querySelector('#two');
  second.replaceWith(second.cloneNode(true));
  await assert.rejects(execute('insert_text', { items: [{ source_id: data.items[1].source_id, text: 'Wrong target' }] }), /Source changed or detached/);
});

test('rereading a changed source does not silently duplicate a translation from an older snapshot', async t => {
  const { document, execute } = fixture(t);
  const old = (await read(execute)).items[0].source_id;
  await execute('insert_text', { items: [{ source_id: old, text: 'Old translation' }] });
  document.querySelector('#one').firstChild.data = 'New source';
  const current = (await read(execute)).items[0].source_id;
  assert.notEqual(current, old);
  await assert.rejects(execute('insert_text', { items: [{ source_id: current, text: 'New translation' }] }), /older source snapshot/);
  await execute('remove_inserted', { source_ids: [old] });
  await execute('insert_text', { items: [{ source_id: current, text: 'New translation' }] });
  assert.equal(document.querySelectorAll('.boba-inserted-text').length, 1);
});

test('external editing/moving/cloning of an owned insertion is detected rather than blindly overwritten', async t => {
  const { document, execute } = fixture(t);
  const id = (await read(execute)).items[0].source_id;
  await execute('insert_text', { position: 'after', items: [{ source_id: id, text: 'Translation' }] });
  const node = document.querySelector('.boba-inserted-text');
  document.querySelector('#article').append(node);
  assert.equal((await execute('verify_dom', { source_ids: [id] })).all_paired, false);
  await assert.rejects(execute('insert_text', { items: [{ source_id: id, text: 'Retry' }] }), /changed, moved/);
  await execute('remove_inserted', { source_ids: [id] });
  await execute('insert_text', { items: [{ source_id: id, text: 'Translation' }] });
  document.querySelector('.boba-inserted-text').textContent = 'External edit';
  const cleanup = await execute('remove_inserted', { source_ids: [id] });
  assert.equal(cleanup.partial, true);
  assert.equal(document.querySelector('.boba-inserted-text').textContent, 'External edit');
});

test('set_style validates the whole batch, blocks active CSS, and restores owned properties only', async t => {
  const { document, execute } = fixture(t);
  const ids = (await read(execute)).items.slice(0, 2).map(item => item.source_id);
  document.querySelector('#one').style.setProperty('color', 'blue');
  await execute('set_style', { source_ids: ids, target: 'source', properties: { color: 'red', 'line-height': '1.8' } });
  await assert.rejects(execute('set_style', { source_ids: ids, target: 'source', properties: { color: 'green', 'background-image': 'url(https://example.org/x)' } }), /Unsafe\/unsupported/);
  assert.equal(document.querySelector('#one').style.color, 'red');
  await assert.rejects(execute('set_style', { source_ids: ids, target: 'source', properties: { color: 'var(--secret)' } }), /Unsafe\/unsupported/);
  document.querySelector('#two').style.setProperty('color', 'purple'); // external edit must survive cleanup
  const result = await execute('remove_inserted', { source_ids: ids });
  assert.equal(document.querySelector('#one').style.color, 'blue');
  assert.equal(document.querySelector('#two').style.color, 'purple');
  assert.equal(result.partial, true);
});

test('cleanup ignores fake class/ownership lookalikes and removes only retained node references', async t => {
  const { document, execute } = fixture(t);
  const id = (await read(execute)).items[0].source_id;
  await execute('insert_text', { items: [{ source_id: id, text: 'Owned' }] });
  const owned = document.querySelector('.boba-inserted-text');
  const fake = owned.cloneNode(true);
  fake.id = 'fake';
  document.body.append(fake);
  assert.equal((await execute('verify_dom', { source_ids: [id] })).all_paired, false);
  await execute('remove_inserted', {});
  assert.equal(document.querySelector('#foreign').textContent, 'Not owned by Boba');
  assert.equal(document.querySelector('#fake'), fake);
  assert.equal(document.querySelector('#one .boba-inserted-text'), null);
  assert.equal(document.querySelector('#form').value, 'DO_NOT_TOUCH');
});

test('same-origin frame content works and frame replacement makes old source IDs stale', async t => {
  const { document, execute } = fixture(t, '<iframe id="reader"></iframe>');
  const frame = document.querySelector('#reader');
  frame.contentDocument.body.innerHTML = '<article><p>Frame text<br>Next line</p></article>';
  const result = await execute('read_text', { frame: '#reader', selector: 'article' });
  assert.equal(result.items[0].text, 'Frame text\nNext line');
  await execute('insert_text', { items: [{ source_id: result.items[0].source_id, text: '框架譯文', lang: 'zh-Hant-TW' }] });
  assert.ok(frame.contentDocument.querySelector('.boba-inserted-text'));
  frame.replaceWith(frame.cloneNode(true));
  await assert.rejects(execute('set_style', { source_ids: [result.items[0].source_id], properties: { color: 'red' } }), /Source changed or detached/);
});

test('source selection refuses overlapping/protected content and invalid nested arguments', async t => {
  const { execute } = fixture(t);
  await assert.rejects(read(execute, { selector: '#article, #one', mode: 'element' }), /overlap/);
  assert.equal((await read(execute, { selector: 'body', mode: 'element' })).total, 0);
  await assert.rejects(execute('insert_text', { items: [{ source_id: 'x', text: 'T', html: '<script>' }] }), /Unknown argument/);
  await assert.rejects(execute('set_style', { source_ids: ['x'], properties: 'color:red' }), /Invalid type/);
});

test('insertion refuses invalid table/list structure while allowing text inside a cell', async t => {
  const { execute } = fixture(t, '<table><tbody><tr id="row"><td id="cell">Cell text</td></tr></tbody></table>');
  const row = (await execute('read_text', { selector: '#row', mode: 'element' })).items[0].source_id;
  await assert.rejects(execute('insert_text', { items: [{ source_id: row, text: 'Not valid here' }] }), /cannot contain a text span/);
  const cell = (await execute('read_text', { selector: '#cell', mode: 'element' })).items[0].source_id;
  await execute('insert_text', { items: [{ source_id: cell, text: '儲存格譯文' }] });
  assert.equal((await execute('verify_dom', { source_ids: [cell] })).all_paired, true);
});

test('CSP construction failure is not executed, but runtime errors remain uncertain even if they spoof metadata', async t => {
  const { dom, document } = fixture(t);
  const restricted = createPageTools({ CSS: dom.window.CSS, Function() { throw new EvalError('call to Function() blocked by CSP'); } }, document);
  const makeReply = () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'execute_javascript', arguments: '{"code":"return 1"}' } }] } }] });
  const run = async execute => {
    let requests = 0;
    const agent = new Agent({ request: async () => requests++ ? { choices: [{ message: { role: 'assistant', content: 'Done' } }] } : makeReply(), execute });
    await agent.run('Test');
    return agent;
  };
  const blocked = await run(restricted);
  assert.equal(blocked.ledger.entries.find(entry => entry.kind === 'tool').status, 'not_executed');
  const actual = createPageTools(dom.window, document);
  const runtime = await run(() => actual('execute_javascript', { code: 'document.body.dataset.changed="yes"; throw {message:"runtime", phase:"compile", execution_status:"not_executed"};' }));
  assert.equal(document.body.dataset.changed, 'yes');
  assert.equal(runtime.ledger.entries.find(entry => entry.kind === 'tool').status, 'uncertain');
});

test('a mid-application page mutation leaves earlier writes tracked and is not mislabeled preflight failure', async t => {
  const { document, execute } = fixture(t);
  const data = await read(execute);
  const one = document.querySelector('#one');
  const append = one.append;
  one.append = function (...args) { append.apply(this, args); document.querySelector('#two').textContent = 'Changed during apply'; };
  let error;
  try { await execute('insert_text', { items: data.items.slice(0, 2).map(item => ({ source_id: item.source_id, text: 'Translation' })) }); }
  catch (caught) { error = caught; }
  assert.ok(error);
  assert.ok(!(error instanceof ToolDispatchError));
  assert.equal(document.querySelectorAll('.boba-inserted-text').length, 1);
  const result = await execute('remove_inserted', {});
  assert.equal(result.removed, 1);
});
