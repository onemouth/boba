/* Runs only on the trusted localhost origin. Never send auth over the port. */
(() => {
  'use strict';
  const session = location.hash.slice(1);
  const status = document.getElementById('connection');
  const connectButton = document.getElementById('connect');
  if (!/^[\da-f-]{36}$/i.test(session) || !window.opener) {
    status.textContent = 'Run the Boba snippet in your target page first. A COOP-isolated page may prevent this connection.';
    return;
  }
  let peer;
  let view;
  let targetOrigin;
  let bound = false;
  let connected = false;
  let timer;
  const opener = window.opener;
  function receive(event) {
    if (bound || event.source !== opener || !/^https?:\/\//.test(event.origin) || event.origin === location.origin || event.data?.type !== 'boba-connect' || event.data?.session !== session || event.ports.length !== 1) return;
    bound = true;
    targetOrigin = event.origin;
    clearInterval(timer);
    window.removeEventListener('message', receive);
    history.replaceState(null, '', '/devtools/');
    peer = createBobaPeer(event.ports[0], { onDisconnect(reason) {
      status.textContent = reason;
      connectButton.disabled = true;
      view?.disconnect(reason);
    } });
    status.textContent = `Target: ${targetOrigin}. Connect only if this is the page you intended.`;
    connectButton.disabled = false;
  }
  // The hello contains only an unprivileged session ID. The destination origin
  // is not known until the opener responds. No credentials/results use '*'.
  function hello() { opener.postMessage({ type: 'boba-ready', session }, '*'); }
  window.addEventListener('message', receive);
  timer = setInterval(hello, 500);
  hello();
  const handshakeTimeout = setTimeout(() => {
    if (!bound) { clearInterval(timer); status.textContent = 'No target connection. Rerun the snippet; COOP-isolated pages are unsupported.'; }
  }, 15000);

  connectButton.addEventListener('click', () => {
    if (connected || !peer) return;
    connected = true;
    connectButton.disabled = true;
    status.textContent = `Connected: ${targetOrigin}. Reloading the target ends this session.`;
    function nativeRequest(options) {
      const url = new URL(options.url);
      if (url.origin !== location.origin) throw new Error('DevTools controller requests must stay on its localhost origin.');
      const xhr = new XMLHttpRequest();
      xhr.open(options.method, url.href);
      xhr.timeout = options.timeout;
      for (const [name, value] of Object.entries(options.headers || {})) xhr.setRequestHeader(name, value);
      xhr.onload = () => options.onload({ status: xhr.status, responseText: xhr.responseText });
      xhr.onerror = options.onerror;
      xhr.ontimeout = options.ontimeout;
      xhr.onabort = options.onabort;
      xhr.send(options.data);
      return { abort: () => xhr.abort() };
    }
    view = BobaRuntime.mountPanel({
      window, document, unsafeWindow: window,
      serverOrigin: location.origin,
      autoOpen: true,
      onClose: () => window.close(),
      executePageTool: (name, args, signal) => peer.call(name, args, signal),
      getPageContext: signal => peer.call('page_context', {}, signal),
      GM_getValue(_key, fallback) {
        try { return JSON.parse(sessionStorage.getItem('boba.devtools.settings')) || fallback; }
        catch { return fallback; }
      },
      GM_setValue(_key, value) { sessionStorage.setItem('boba.devtools.settings', JSON.stringify(value)); },
      GM_xmlhttpRequest: nativeRequest,
      GM_registerMenuCommand() {},
      GM_openInTab(url) {
        const target = new URL(url);
        if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== location.port || !target.pathname.startsWith('/install/')) throw new Error('Invalid installation link');
        target.host = location.host;
        window.open(target.href, '_blank', 'noopener');
      },
    });
    if (!view) status.textContent = 'Boba UI failed to start. Check the browser console.';
  });
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    clearTimeout(handshakeTimeout);
    peer?.close();
    view?.disconnect();
  }, { once: true });
})();
