# Boba for Chrome DevTools

A standalone **Sources → Snippets** entry point. No userscript manager or Chrome extension is required.

The snippet installs page tools in the target document and opens a **separate localhost controller window** for chat. This is deliberate: a page-injected UI must not hold the pairing token that authorizes host-file access. The existing userscript remains supported.

## Quick start (macOS)

1. Start/restart the updated server in the project directory:

   ```sh
   cd ~/Projects/boba
   go run . serve
   ```

   If you are running a previously compiled binary, rebuild it first. Public UI assets are embedded at compile time.

2. Copy the snippet:

   ```sh
   pbcopy < devtools/boba-snippet.js
   ```

   The checked-in file defaults to `http://127.0.0.1:8787`. If your configured port differs, either edit `BOBA_SERVER_ORIGIN` near the top, or copy the server-generated version (substitute your port):

   ```sh
   curl -fsS http://127.0.0.1:8787/devtools/boba-snippet.js | pbcopy
   ```

   This endpoint serves public code only, with the configured port. It contains no API key or pairing token.

3. In **Chrome**, open the page you want to operate on. Open DevTools → **Sources → Snippets** (possibly under **More tabs**), create a snippet named `Boba`, and paste the entire file. Save it.
4. Run it with the DevTools Run button, or **⌘Enter** while the snippet editor is focused.
5. A localhost window opens. Check its address and the displayed target origin, then click **Connect to this page**.
6. In the Boba settings inside that localhost window, enter the `pairing_token` from your project `config.json` and click **Save & connect**. Do **not** paste your OpenRouter API key or pairing token into the target webpage or snippet source.
7. Send instructions as usual. The controller supports the same prompts, image attachments, agent loop, workspace tools, and Stop control as the userscript.

The target page gets a small **Open Boba** button. **Option+Shift+B** focuses/reopens the controller. Rerunning the snippet focuses an existing live controller instead of creating another one. Closing the controller disconnects the page tools.

No userscript update is required to use this version. If Boba is also installed through a userscript manager, avoid running both entry points on the same target page at once.

## Lifecycle

- SPA navigation can continue while the same document and bridge survive; page URL/title are fetched again for every instruction.
- **Full page reload or navigation ends the session.** The old controller cancels its work and disables Send. Rerun the snippet in the new document and connect a new controller.
- Chat history is in memory. Controller settings, including its token, use **sessionStorage on the localhost origin**, not the target origin or shared snippet code. They are separate from Violentmonkey settings.
- **Stop** cancels model requests, outstanding page-tool calls, and later steps. It cannot undo completed changes or reliably interrupt generated JavaScript that has already started.
- Page tools have a 45-second response timeout. A slow/frozen page produces an error rather than waiting forever; underlying JavaScript may continue.
- Long tasks use small complete batches. The shared agent handles `checkpoint` internally for multi-response prose, discards truncated completions, and retries a smaller batch at most twice within the 20-step budget. It never executes partial tool arguments or combines broken JavaScript fragments. The Go server defaults to `max_tokens: 16384` (configurable). After updating, restart the server, replace the saved snippet with the regenerated file, and open a fresh controller.

## Progress and failure history

The shared **Progress & history** view separates runtime acknowledgements, undispatched calls, failed reads, uncertain mutations and unverified model checkpoints. Follow-ups receive a compact ledger projection. Exact mutation repeats and changes to the same unresolved file are blocked until explicit user review; no raw credential or host-tool channel is added to the page bridge. See [ledger semantics and limits](../docs/progress.md).

A disconnected controller may still display its old records until closed, but these are not automatically transferred to a new controller or reconnected target. New chat clears them without undoing page/file effects. Replace the snippet with the regenerated version and open a fresh controller to apply an update.

## Permissions and limitations

This is a snippet, **not** a DevTools extension or privileged browser automation API:

- DOM inspect/query/click/type/scroll and [structured text/style tools](../docs/structured-dom.md) run in the target page. Same-origin frame access remains subject to normal browser rules. `read_text`, `insert_text`, `set_style`, `remove_inserted` and `verify_dom` do not use eval or arbitrary HTML and are available through the page-tool allowlist.
- Generated JavaScript uses the target page's Function constructor. **Strict CSP can block it**, even when DevTools successfully launches the initial snippet. Boba reports the error; it does not relax CSP or claim success. Prefer structured DOM tools on these pages.
- There is no tab-management, debugger, native screenshot, or filesystem API in the snippet. User-attached screenshots still work with a vision model. Host files go through the authenticated Go server.
- Popup blockers can stop the first `window.open`. Click the page's **Open Boba** button to retry with a direct user gesture. If necessary, allow this popup for the page.
- A site's **Cross-Origin-Opener-Policy (COOP)** can sever the cross-origin popup connection. These pages are unsupported by this transport; a browser extension is the longer-term solution. Do not disable browser isolation/security settings as a workaround.
- COOP-restricted/opaque/browser-internal origins and cross-origin frames are not bypassed. The snippet refuses to target the controller's own localhost origin.
- The controller must be a top-level window. It deliberately cannot be embedded in a webpage iframe.

## Security model

```text
Target page / snippet                  Localhost controller
DOM tools + page code  <-- MessagePort -->  Chat + agent loop
                                              |
                                      authenticated same-origin HTTP
                                              |
                                      Go server → OpenRouter / workspace
```

The port transports only page-tool calls, context metadata, bounded results, cancellation, and disconnects. The controller accepts **no inbound host-tool or network requests** from it. API keys remain server-side; pairing credentials remain in the localhost UI and its HTTP Authorization headers.

The initial hello broadcasts only a random, non-privileged session binding. The subsequent handshake validates sender window, origin, session, and transferred port. The user confirms the target origin before chat starts. No pairing token is placed in URLs, generated source, or page messages. The server's existing API authentication, Host validation, and no-CORS policy remain unchanged. Only credential-free static controller/snippet assets are public; controller responses prohibit framing and use a restrictive CSP.

**This is not a sandbox against the target page.** The page owns the snippet's execution environment, can tamper with tools/results, and can supply prompt-injection content. Origin separation protects the direct credential/HTTP channel; it does not make page data trustworthy or prevent an agent from being misled into a host-file operation. The MVP still executes automatically without approval. Use trusted/test pages and your existing workspace boundary.

## Development

`userscript/boba.user.js` is the canonical shared runtime. Its `mountPanel(platform)` adapter is used by both versions. No bundler or runtime npm dependency is required.

After modifying the shared runtime, bridge, or snippet entry:

```sh
npm run build:devtools
npm run check
```

Commit the generated `runtime.js` and `boba-snippet.js` along with their sources so `go run . serve` works without Node installed.

Files:

- `snippet-entry.js`: page launcher, session handshake, page-tool allowlist and lifecycle.
- `bridge.js`: bidirectional MessagePort RPC with cancellation/timeouts; controller has no inbound executor.
- `controller.html`, `controller.css`, `controller.js`: trusted localhost UI and same-origin network adapter.
- `runtime.js`, `boba-snippet.js`: generated, checked-in artifacts.
- `../scripts/build-devtools.cjs`: dependency-free generator, supports `--check`.

Tests:

```sh
go test -race ./...
go vet ./...
npm ci
npm test
npm run check
npx playwright install chromium firefox
npm run test:browser
```

Chromium tests run a real browser and real Go server/workspace tools with a deterministic fake OpenRouter and temporary workspace. They verify DOM changes, file output, follow-up, token separation, Stop/upstream cancellation, duplicate launch behavior, reload disconnect, and structured tools under strict CSP. They do not make paid model calls or prove every site's compatibility. Firefox tests continue covering the userscript.

References: [Chrome Snippets](https://developer.chrome.com/docs/devtools/javascript/snippets), [postMessage security](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage), [COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy).
