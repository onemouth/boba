# Boba MVP

Status: Initial implementation built and automated tests passing. A live installed-userscript check in Zen verified real OpenRouter tool calls, DOM modifications, form filling without submission, follow-up translation, and workspace writes. Two installed instances were found; only one was paired/tested, and manager ownership was not independently identified. Generated-script installation, strict CSP, full-page translation, and settings persistence still need validation; see README.md.

## Goal

A lightweight browser agent running in a Userscript. Users manipulate the current webpage through natural-language instructions and follow-up messages.

Target: Firefox-based browsers, including Zen, + Violentmonkey on macOS. Zen is installed on the development machine; use the existing FoxPilot browser MCP for live checks.

## Architecture

### Userscript

- Minimal chat panel with configurable keyboard shortcut.
- In-memory conversation for the current document.
- Simple automatic tool-calling loop.
- Tool activity, errors, and an obvious Stop control.
- No approval workflow, risk classifier, or per-site permission management in MVP.

### Local server

- Implemented in Go, following version-appropriate Modern Go guidance.
- Listens only on 127.0.0.1.
- Proxies OpenRouter requests; server supplies API key and model name.
- Provides workspace file tools and userscript installation URLs.
- Authenticates userscript requests using a pairing token; never expose the token to page code or model context.
- Rejects unauthenticated requests, including access to generated files.

### Configuration

Store config.json in the project directory, not the workspace. Includes OpenRouter API key, model, server port, and pairing token. Ignore real configuration in Git and provide a secret-free example.

The model's file tools must not be able to access server configuration.

## Workspace

Fixed root: ~/Documents/boba

Suggested directories:

- prompts/
- output/
- userscripts/

File operations are confined to this root, including protection against traversal and symlink escape. Writes and overwrites require no approval. Deletion moves files to macOS Trash rather than permanently removing them.

## Tools

### Page

- inspect_page
- query_elements
- click
- type
- scroll
- execute_javascript

Prefer structured tools for ordinary interactions; allow JavaScript for other operations. Exact schemas and execution context are implementation decisions.

Requested access includes form values, hidden DOM, attributes, page scripts, storage, cookies, and iframes where browser APIs permit it. Browser security restrictions still apply: unrestricted intent does not bypass cross-origin, HttpOnly, or execution-context boundaries.

### Host files

- list_files
- search_files
- read_file
- write_file
- trash_file

### Vision

Vision input is implemented as user-attached or pasted PNG/JPEG/WebP screenshots/images, using a vision-capable OpenRouter model. No automatic screenshot tool is claimed. Violentmonkey's documented GM APIs do not provide native tab capture, and getDisplayMedia requires user activation and permission. If automatic capture requires an additional extension or macOS permissions, ask before expanding architecture.

## Prompts and generated userscripts

- Reusable Markdown prompts under prompts/.
- Invoke through /name or a UI picker.
- Translation and other tasks are driven by instructions/prompts, not dedicated feature-specific pipelines.
- Save generated .user.js files in userscripts/.
- Offer an installation URL; user completes installation in Violentmonkey.
- Do not automatically modify Boba itself.

## Lifecycle

- Automatically execute tools until completion, cancellation, error, or a bounded step limit.
- Support follow-up instructions in the same document.
- SPA navigation may continue if the agent instance remains alive.
- Full reload or document navigation ends the session; no cross-page task recovery.
- Closing/reopening the panel retains the current document's conversation.
- No persistent chat history across document reloads or browser restarts.
- Stop cancels outstanding model requests where possible and prevents subsequent tool calls. It cannot guarantee interruption of synchronous JavaScript or undo completed actions.
- Bound tool output/context size and iteration count.

## Explicit risk acceptance

The user selected automatic execution without approval, including arbitrary JavaScript and workspace overwrites. Sensitive DOM values, including password values, are not automatically redacted and may be sent to OpenRouter when accessed for a task. UI/documentation must make this behavior clear.

This MVP is not a strong sandbox against untrusted page content or generated JavaScript. Prompt injection and unintended page actions remain risks; do not claim that localhost authentication or workspace confinement solves them.

## Acceptance scenarios

1. Translate the current page into Traditional Chinese using a prompt.
2. Hide a sidebar and widen the main content.
3. Extract links, format them as Markdown, and save to the workspace.
4. Fill a form while respecting an explicit instruction not to submit it.
5. Generate a reusable site-specific userscript, save it, and offer an installation entry point.

Additional checks: follow-up instructions work; Stop prevents further steps; workspace escape attempts fail; file trash uses macOS Trash; server rejects unauthenticated access; secrets are not committed.

## Deferred

- Approval workflows and risk classification.
- Persistent site permissions.
- Task recovery across reloads/navigation.
- Persistent conversation history.
- Multi-tab coordination.
- DOM undo.
- Executable skill/plugin extension system.

## Implementation uncertainties to resolve

- Screenshot capability in Firefox + Violentmonkey.
- Reliable userscript installation handoff from authenticated localhost delivery.
- Supported page execution context and availability limits for cookies, storage, frames, and script execution.
