# Development

Requires Go 1.25+ and Node.js/npm for JavaScript tests and generated DevTools assets.

## Checks

```sh
npm ci
npx playwright install chromium firefox
npm run build:devtools
npm run check
npm test
npm run test:browser
go test -race ./...
go vet ./...
go build -o boba .
git diff --check
```

The userscript is the canonical shared runtime. After changing its shared section, the bridge or snippet entry, regenerate and commit `devtools/runtime.js` and `devtools/boba-snippet.js` with their sources. The server embeds these assets; rebuild/restart it after changes. Users do not need Node.js to run Boba.

Go tests use temporary workspaces and Trash directories. Shell integration tests require macOS and exercise the actual OS sandbox. Browser tests use mocked model responses; Firefox tests mock GM APIs, while Chromium tests run a real Go controller/server. These tests do not make paid model calls or guarantee compatibility with every site.

## Local demo

```sh
npm run demo
# http://127.0.0.1:8790/
```

This deterministic UI demo mocks both the model and GM bridge; it has no API key or host-file access. For real integration testing, serve `examples/` as ordinary static pages and use the installed userscript with your local server.

Keep credentials, local output, browser profiles and test artifacts out of Git. Real configuration belongs in the gitignored project `config.json`, not the agent workspace.
