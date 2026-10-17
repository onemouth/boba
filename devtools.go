package main

import (
	"embed"
	"fmt"
	"net/http"
	"strings"
)

// These assets contain no credentials. Only the controller, on our origin,
// authenticates requests; the target page receives page-tool RPC messages only.
//
//go:embed devtools/controller.html devtools/controller.css devtools/controller.js devtools/bridge.js devtools/runtime.js devtools/boba-snippet.js
var devtoolsAssets embed.FS

func (a *app) devtools(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("asset")
	contentType := "application/javascript; charset=utf-8"
	switch name {
	case "":
		name = "controller.html"
		contentType = "text/html; charset=utf-8"
	case "controller.css":
		contentType = "text/css; charset=utf-8"
	case "controller.js", "bridge.js", "runtime.js", "boba-snippet.js":
	default:
		http.NotFound(w, r)
		return
	}
	data, err := devtoolsAssets.ReadFile("devtools/" + name)
	if err != nil {
		fail(w, 500, "DevTools asset unavailable")
		return
	}
	if name == "boba-snippet.js" {
		data = []byte(strings.Replace(string(data),
			"const BOBA_SERVER_ORIGIN = 'http://127.0.0.1:8787';",
			fmt.Sprintf("const BOBA_SERVER_ORIGIN = 'http://127.0.0.1:%d';", a.cfg.Port), 1))
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cross-Origin-Opener-Policy", "unsafe-none")
	w.Header().Set("Permissions-Policy", "camera=(), microphone=(), display-capture=()")
	_, _ = w.Write(data)
}
