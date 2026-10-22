# Chrome DevTools setup

Run Boba through **Sources → Snippets**, without a userscript manager or browser extension. The snippet operates on the target page while chat and credentials stay in a separate localhost window.

## Setup

1. Configure and start the server as described in the [quick start](../README.md#quick-start). Rebuild/restart after updates: controller assets are embedded in the binary.
2. Copy the snippet:

   ```sh
   pbcopy < devtools/boba-snippet.js
   ```

   The checked-in snippet defaults to port `8787`. For another configured port, copy the server-generated version instead:

   ```sh
   curl -fsS http://127.0.0.1:YOUR_PORT/devtools/boba-snippet.js | pbcopy
   ```

3. Open your target page in Chrome. In **DevTools → Sources → Snippets**, create a snippet named `Boba`, paste the code and save.
4. Run it with the Run button or **⌘Enter** while the snippet editor is focused.
5. In the localhost window, check the address and target origin, then click **Connect to this page**.
6. Enter your pairing token in Boba settings and choose **Save & connect**. **Never put the token or OpenRouter API key in the target page or snippet.**

Use the page's **Open Boba** button or **Option + Shift + B** to focus/reopen the controller. Rerunning the snippet focuses an existing live controller. Avoid running both the userscript and snippet on the same page.

## Session behavior

- Full target reload/navigation ends the session. Rerun the snippet and connect a new controller; history is not automatically transferred. SPA navigation can continue while the document survives.
- Chat is in memory. Controller settings use localhost `sessionStorage`, separate from Violentmonkey settings and target-page storage.
- Closing the controller disconnects its page bridge. It does not undo effects; clean up owned insertions before closing, or reload to restore the page.
- Stop cancels pending requests and later steps but cannot undo effects or reliably interrupt running page JavaScript. Page-tool responses time out after 45 seconds; underlying code may continue.
- [Progress handling](../docs/progress.md), prompts, image attachments and [host tools](../docs/host-tools.md) work as in the userscript.

## Troubleshooting and boundaries

| Issue | What to do |
| --- | --- |
| Popup blocked | Click **Open Boba** for a direct user gesture, or allow the popup for this page. |
| JavaScript blocked by CSP | Prefer [structured DOM tools](../docs/structured-dom.md); do not disable CSP. |
| Connection severed by COOP | This transport cannot support the page. Do not disable browser isolation. |
| Controller disconnected after reload | Rerun the snippet in the new document. |
| Protected page / cross-origin iframe | Normal browser restrictions apply; the snippet cannot bypass them. |

The snippet has no debugger, tab-management or native screenshot privileges. It cannot target the controller's own localhost origin; the controller must be a top-level window.

Only page-tool calls, context and lifecycle messages cross the MessagePort. Host requests originate in the authenticated localhost controller, and credentials never enter page messages. This protects the direct host channel, not the model from misleading page content. Execution remains automatic and prompt injection remains a risk.

See [architecture](../docs/architecture.md) for security boundaries and [development](../docs/development.md) for rebuilding generated assets.
