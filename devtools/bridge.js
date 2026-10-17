/* Shared MessagePort RPC. No network, credentials, or host-file bridge here. */
function createBobaPeer(port, { execute, onDisconnect = () => {}, timeoutMs = 45000 } = {}) {
  const pending = new Map();
  const active = new Map();
  let closed = false;
  let sequence = 0;
  const stopped = () => new DOMException('Stopped', 'AbortError');
  function send(message) {
    if (closed) throw new Error('Target page disconnected. Rerun the snippet.');
    port.postMessage(message);
  }
  function finish(reason, notify) {
    if (closed) return;
    if (notify) { try { port.postMessage({ type: 'close', reason }); } catch {} }
    closed = true;
    for (const item of pending.values()) { item.cleanup(); item.reject(new Error(reason)); }
    pending.clear();
    for (const controller of active.values()) controller.abort();
    active.clear();
    port.close();
    onDisconnect(reason);
  }
  port.onmessage = async event => {
    const message = event.data;
    if (closed || !message || typeof message !== 'object') return;
    if (message.type === 'close') { finish('Target page disconnected. Rerun the snippet.', false); return; }
    if (typeof message.id !== 'string' || message.id.length > 64) return;
    if (message.type === 'result') {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      item.cleanup();
      if (message.ok === true) {
        try {
          if (JSON.stringify(message.value ?? null).length > 100000) throw new Error('Page result exceeds size limit');
          item.resolve(message.value);
        } catch (error) { item.reject(error); }
      } else item.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 1000) : 'Page tool failed'));
      return;
    }
    if (message.type === 'cancel') { active.get(message.id)?.abort(); return; }
    // A controller peer has no inbound executor: page messages can never invoke
    // its local HTTP client or host-file tools.
    if (message.type !== 'call' || !execute || active.has(message.id)) return;
    if (active.size >= 8) { send({ type: 'result', id: message.id, ok: false, error: 'Too many concurrent page tools' }); return; }
    const controller = new AbortController();
    active.set(message.id, controller);
    try {
      if (typeof message.method !== 'string' || !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) throw new Error('Invalid page-tool request');
      if (JSON.stringify(message).length > 100000) throw new Error('Page-tool request exceeds size limit');
      const value = await execute(message.method, message.args, controller.signal);
      if (!closed && !controller.signal.aborted) send({ type: 'result', id: message.id, ok: true, value });
    } catch (error) {
      if (!closed && !controller.signal.aborted) send({ type: 'result', id: message.id, ok: false, error: String(error.message).slice(0, 1000) });
    } finally { active.delete(message.id); }
  };
  port.onmessageerror = () => finish('Page bridge could not deserialize a message.', true);
  port.start();
  return {
    call(method, args = {}, signal) {
      if (closed) return Promise.reject(new Error('Target page disconnected. Rerun the snippet.'));
      if (signal?.aborted) return Promise.reject(stopped());
      if (pending.size >= 32) return Promise.reject(new Error('Too many pending page requests'));
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        function cancel() {
          if (!pending.delete(id)) return;
          cleanup();
          try { send({ type: 'cancel', id }); } catch {}
          reject(stopped());
        }
        timer = setTimeout(() => {
          pending.delete(id);
          cleanup();
          try { send({ type: 'cancel', id }); } catch {}
          reject(new Error('Page tool timed out. Check the target page or rerun the snippet.'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, cleanup });
        signal?.addEventListener('abort', cancel, { once: true });
        try { send({ type: 'call', id, method, args }); }
        catch (error) { pending.delete(id); cleanup(); reject(error); }
      });
    },
    close(reason = 'Target page disconnected. Rerun the snippet.') { finish(reason, true); },
  };
}
if (typeof window === 'undefined' && typeof module !== 'undefined') module.exports = { createBobaPeer };
