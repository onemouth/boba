package main

import (
	"strings"
	"testing"
)

func TestDevtoolsAssetsArePublicButContainNoCredentials(t *testing.T) {
	a := testApp(t)
	a.cfg.Port = 9123
	for _, path := range []string{"/devtools/", "/devtools/controller.js", "/devtools/controller.css", "/devtools/bridge.js", "/devtools/runtime.js", "/devtools/boba-snippet.js"} {
		t.Run(path, func(t *testing.T) {
			w := apiRequest(a, "GET", path, "", "")
			if w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			for _, secret := range []string{a.cfg.APIKey, a.cfg.Token} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("credential in public asset")
				}
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("must not enable page-origin CORS")
			}
			if w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
				t.Fatal("controller must not be frameable")
			}
			if path == "/devtools/boba-snippet.js" && !strings.Contains(w.Body.String(), "const BOBA_SERVER_ORIGIN = 'http://127.0.0.1:9123';") {
				t.Fatal("snippet must use configured port")
			}
		})
	}
	for _, path := range []string{"/devtools/config.json", "/devtools/snippet-entry.js", "/devtools/controller.html"} {
		if w := apiRequest(a, "GET", path, "", ""); w.Code != 404 {
			t.Fatalf("unexpected public route %s: %d", path, w.Code)
		}
	}
	for _, endpoint := range []struct{ method, path, body string }{
		{"GET", "/api/health", ""}, {"POST", "/api/files", `{}`}, {"POST", "/v1/chat/completions", `{}`},
	} {
		if w := apiRequest(a, endpoint.method, endpoint.path, endpoint.body, ""); w.Code != 401 {
			t.Fatal("DevTools must not weaken API authentication")
		}
	}
}
