# Architecture

Boba has two browser entry points sharing one agent runtime and a localhost Go server.

```text
Firefox / Zen userscript ── authenticated HTTP ──┐
                                               ├── Go server ── OpenRouter
Chrome page ── MessagePort ── localhost UI ──────┘       │
                                                Workspace tools
```

## Components

| Component | Responsibility |
| --- | --- |
| `userscript/boba.user.js` | Canonical agent loop, chat panel, page tools and progress ledger. Standalone; no runtime npm dependencies. |
| `devtools/snippet-entry.js`, `bridge.js` | Target-page launcher and MessagePort transport. |
| `devtools/controller.*` | Localhost chat UI and authenticated host requests. |
| `devtools/runtime.js`, `boba-snippet.js` | Generated shared runtime and snippet. |
| `server.go`, `devtools.go` | OpenRouter proxy, pairing authentication, static assets and installation links. |
| `workspace.go`, `bash.go` | Confined file operations and macOS sandboxed commands. |

The model proposes tool calls; the runtime validates and executes them, records results, and requests another response until completion, Stop or a limit. Tool acknowledgement is not independent verification of task success.

## Security boundaries

- The server binds to `127.0.0.1`, validates the Host header, requires a bearer pairing token for APIs, and does not enable CORS. Credential-free controller/snippet assets are public.
- The server owns the OpenRouter API key and model configuration. Store `config.json` outside the model-accessible workspace.
- The userscript keeps pairing settings in manager storage, not page-visible DOM. Arbitrary JavaScript runs in the page realm without host APIs supplied.
- The Chrome controller holds pairing credentials on the localhost origin. The page bridge carries only page tools, context, results and lifecycle messages; it accepts no inbound host requests in the controller. The handshake checks sender, origin and session, and the user confirms the target origin. The controller cannot be framed.
- File APIs use `os.Root` for traversal/symlink confinement and atomic replacement. The [shell sandbox](host-tools.md) separately restricts subprocess access at OS level.
- Generated-script installation uses short-lived capability URLs, never the main pairing token. Installation requires a user action.

Boba runs automatically. Malicious page content can mislead the model into unwanted actions within its capabilities; origin isolation and workspace confinement do not solve prompt injection. Browser JavaScript is not covered by the shell sandbox.

## Session lifecycle

Conversations, progress and DOM ownership references are in memory. Full document reload/navigation ends a userscript task; target reload disconnects a Chrome controller. SPA navigation can continue while the document survives, but a URL change requires fresh inspection. **New** clears chat/progress without undoing effects. There is no persistent task recovery.

See [progress handling](progress.md), [DOM tools](structured-dom.md) and [Chrome setup](../devtools/README.md) for operational details.
