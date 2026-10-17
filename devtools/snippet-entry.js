// Source entry; run the generated devtools/boba-snippet.js, not this file.
function startBobaSnippet(runtime, createPeer, serverOrigin) {
  const base = new URL(serverOrigin);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Boba requires a loopback HTTP server origin.');
  if (!['https:', 'http:'].includes(location.protocol) || location.origin === base.origin) throw new Error('Run Boba in an ordinary target web page, not its localhost controller.');
  const previous = window.__bobaDevtools;
  if (previous?.focus?.()) return;
  previous?.close?.();
  const session = crypto.randomUUID(); // Session binding only, never an API credential.
  const url = `${base.origin}/devtools/#${session}`;
  const pageTools = runtime.createPageTools(window, document);
  const methods = new Set(['inspect_page', 'query_elements', 'click', 'type', 'scroll', 'execute_javascript']);
  let popup = null;
  let peer = null;
  let disposed = false;
  let monitor;
  const launcher = document.createElement('button');
  launcher.textContent = 'Open Boba';
  launcher.setAttribute('aria-label', 'Open Boba DevTools controller');
  launcher.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#302a23;color:white;border:0;border-radius:8px;padding:10px 14px;font:13px system-ui;cursor:pointer';
  function cleanup() {
    if (disposed) return;
    disposed = true;
    clearInterval(monitor);
    peer?.close();
    window.removeEventListener('message', connect);
    window.removeEventListener('pagehide', cleanup);
    window.removeEventListener('keydown', shortcut, true);
    launcher.remove();
    if (window.__bobaDevtools === api) delete window.__bobaDevtools;
  }
  function open() {
    if (disposed) return false;
    if (popup && !popup.closed) { popup.focus(); return true; }
    popup = window.open(url, `boba-${session}`, 'popup,width=460,height=740');
    if (!popup || popup.closed) {
      console.warn('[Boba] Popup blocked or opener isolated by COOP. Click Open Boba to retry; COOP-isolated sites are not supported.');
      return false;
    }
    return true;
  }
  function connect(event) {
    if (disposed || peer || event.source !== popup || event.origin !== base.origin || event.data?.type !== 'boba-ready' || event.data?.session !== session) return;
    const channel = new MessageChannel();
    peer = createPeer(channel.port1, {
      async execute(method, args, signal) {
        if (method === 'page_context') return { url: location.href, title: document.title };
        if (!methods.has(method)) throw new Error('Unsupported page tool');
        // Bound and serialize page results before crossing the bridge. No page
        // result is ever interpreted as a request to the localhost server.
        return JSON.parse(runtime.bounded(await pageTools(method, args, signal)));
      },
      onDisconnect() { cleanup(); },
    });
    popup.postMessage({ type: 'boba-connect', session }, base.origin, [channel.port2]);
    launcher.textContent = 'Boba connected';
  }
  function shortcut(event) {
    const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
    if (key === 'b' && event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); open(); }
  }
  const api = { focus: () => !disposed && popup && !popup.closed ? (popup.focus(), true) : false, close: cleanup };
  window.__bobaDevtools = api;
  window.addEventListener('message', connect);
  window.addEventListener('pagehide', cleanup, { once: true });
  window.addEventListener('keydown', shortcut, true);
  launcher.addEventListener('click', open);
  document.documentElement.append(launcher);
  monitor = setInterval(() => { if (popup?.closed) cleanup(); }, 1000);
  open();
  console.info('[Boba] Controller opens on localhost. Enter the pairing token only there, never in this page. Reload ends this snippet session.');
}
