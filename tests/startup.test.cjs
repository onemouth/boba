const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../userscript/boba.user.js'), 'utf8');

function setup(t) {
  const dom = new JSDOM('<!doctype html><title>Startup fixture</title><main>Article</main>', {
    url: 'https://example.com/', runScripts: 'dangerously',
  });
  t.after(() => dom.window.close());
  const window = dom.window;
  const roots = [];
  const menus = new Map();
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (options) {
    const root = attach.call(this, options);
    roots.push(root);
    return root;
  };
  window.unsafeWindow = window;
  window.GM_getValue = () => ({});
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = (name, action) => menus.set(name, action);
  window.GM_openInTab = () => {};
  window.GM_xmlhttpRequest = () => assert.fail('Unconfigured startup should not request the server');
  return { window, roots, menus };
}

test('startup does not use HTML sinks or mistake a page module for Node', t => {
  const { window, roots, menus } = setup(t);
  window.module = { exports: { ownedByPage: true } };
  const prototypes = [window.Element.prototype, window.ShadowRoot.prototype];
  const descriptors = prototypes.map(p => Object.getOwnPropertyDescriptor(p, 'innerHTML'));
  for (const prototype of prototypes) {
    Object.defineProperty(prototype, 'innerHTML', { configurable: true,
      set() { throw new TypeError('This document requires TrustedHTML assignment.'); },
    });
  }
  try { window.eval(source); }
  finally { prototypes.forEach((p, i) => Object.defineProperty(p, 'innerHTML', descriptors[i])); }
  assert.equal(window.document.querySelectorAll('boba-panel').length, 1);
  assert.equal(roots[0].querySelector('#input').tagName, 'TEXTAREA');
  assert.equal(window.module.exports.ownedByPage, true);
  assert.ok(menus.has('Open Boba'));
  menus.get('Open Boba')();
  assert.equal(window.document.querySelector('boba-panel').style.display, 'block');
  assert.equal(roots[0].querySelector('#settings').style.display, 'block');
});

test('a duplicate manager does not create another panel or register duplicate menus', t => {
  const { window, roots, menus } = setup(t);
  window.eval(source);
  window.eval(source);
  assert.equal(window.document.querySelectorAll('boba-panel').length, 1);
  assert.equal(roots.length, 1);
  assert.equal(menus.size, 2);
});

test('startup failure leaves a diagnostic menu instead of silently disappearing', t => {
  const { window, menus } = setup(t);
  const errors = [];
  window.console.error = (...args) => errors.push(args);
  window.GM_getValue = () => { throw new Error('Storage unavailable'); };
  let alert = '';
  window.alert = text => { alert = text; };
  window.eval(source);
  assert.equal(window.document.querySelectorAll('boba-panel').length, 0);
  assert.equal(errors[0][0], '[Boba] UI initialization failed');
  assert.ok(menus.has('Boba startup error'));
  menus.get('Boba startup error')();
  assert.ok(alert.includes('Storage unavailable'));
});
