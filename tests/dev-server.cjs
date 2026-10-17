// Disposable local UI fixture with MOCK GM APIs and MOCK model responses.
// Not a Violentmonkey integration test. No OpenRouter calls or host file access.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const shim = `
(() => {
  const modelReply = message => ({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] });
  let step = 0;
  window.unsafeWindow = window;
  window.GM_getValue = () => ({ server:'http://127.0.0.1:8790', token:'demo-pairing-token-not-a-secret', shortcut:'Alt+Shift+B' });
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = (_name, fn) => {
    if (_name === 'Open Boba') {
      const button = document.createElement('button');
      button.textContent = 'Open Boba demo';
      button.onclick = fn;
      document.body.prepend(button);
    }
  };
  window.GM_openInTab = () => {};
  window.GM_xmlhttpRequest = options => {
    let cancelled = false;
    const route = new URL(options.url).pathname;
    let response;
    if (route === '/api/health') response = { model:'MOCK model — no network' };
    if (route === '/api/prompts') response = { prompts:[] };
    if (route === '/v1/chat/completions') {
      const body = JSON.parse(options.data);
      const last = body.messages.at(-1);
      if (last.role === 'tool') response = modelReply({role:'assistant',content:'Demo complete. This response is deterministic, not an LLM result.'});
      else {
        const latest = [...body.messages].reverse().find(m=>m.role==='user');
        const text = typeof latest.content === 'string' ? latest.content : latest.content[0].text;
        const code = /translate|翻譯/i.test(text)
          ? "document.querySelector('#intro').textContent='Boba 是一個小巧的瀏覽器 Agent。你可以請它翻譯文字、調整版面，或整理下方連結。'; return {translated:true};"
          : /fill|填/i.test(text)
          ? "document.querySelector('#demo-name').value='Boba'; document.querySelector('#demo-notes').value='Test only — not submitted'; return {filled:true,submitted:false};"
          : "document.querySelector('#sidebar').style.display='none'; document.querySelector('main').style.gridTemplateColumns='1fr'; return {sidebarHidden:true};";
        response = modelReply({role:'assistant',content:null,tool_calls:[{id:'demo-'+(++step),type:'function',function:{name:'execute_javascript',arguments:JSON.stringify({code})}}]});
      }
    }
    queueMicrotask(() => { if (!cancelled) options.onload({status:200,responseText:JSON.stringify(response)}); });
    return {abort(){cancelled=true;options.onabort();}};
  };
})();
`;
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/' || req.url === '/demo.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let html = fs.readFileSync(path.join(root, 'examples/demo.html'), 'utf8');
    html = html.replace('</html>', '<script src="/mock-gm.js"></script><script src="/boba.js"></script><script>document.querySelector("#mode").textContent="DEVELOPMENT DEMO: mocked GM APIs and model; no OpenRouter or host access. Shortcut: Alt+Shift+B.";</script></html>');
    res.end(html);
  } else if (req.url === '/mock-gm.js' || req.url === '/boba.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(req.url === '/mock-gm.js' ? shim : fs.readFileSync(path.join(root, 'userscript/boba.user.js')));
  } else { res.writeHead(404); res.end(); }
});
server.listen(8790, '127.0.0.1', () => console.log('Mock UI fixture: http://127.0.0.1:8790'));
