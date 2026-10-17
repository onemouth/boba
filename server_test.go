package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	return newApp(config{APIKey: "test-api-secret", Model: "test/model", Port: 8787, Token: "test-pairing-token-123456789"}, testWorkspace(t))
}

func apiRequest(a *app, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8787"+path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	return w
}

func TestAuthenticationAndHost(t *testing.T) {
	a := testApp(t)
	for _, endpoint := range []struct{ method, path, body string }{
		{"GET", "/api/health", ""}, {"GET", "/api/prompts", ""}, {"GET", "/api/userscript", ""},
		{"POST", "/api/files", `{}`}, {"POST", "/api/install", `{}`}, {"POST", "/v1/chat/completions", `{}`},
	} {
		for _, token := range []string{"", "wrong"} {
			w := apiRequest(a, endpoint.method, endpoint.path, endpoint.body, token)
			if w.Code != 401 {
				t.Fatalf("%s = %d", endpoint.path, w.Code)
			}
		}
	}
	w := apiRequest(a, "GET", "/api/health", "", a.cfg.Token)
	if w.Code != 200 || strings.Contains(w.Body.String(), a.cfg.APIKey) || strings.Contains(w.Body.String(), a.cfg.Token) {
		t.Fatal(w.Body.String())
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS must not expose localhost endpoints to pages")
	}
	r := httptest.NewRequest("GET", "http://evil.example/api/health", nil)
	r.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("host check = %d", w.Code)
	}
}

func TestFilesAPIAndPrompts(t *testing.T) {
	a := testApp(t)
	for _, body := range []string{
		`{"operation":"write_file","path":"prompts/translate.md","content":"Translate into Traditional Chinese"}`,
		`{"operation":"read_file","path":"prompts/translate.md"}`,
		`{"operation":"search_files","path":"prompts","query":"Chinese"}`,
		`{"operation":"list_files","path":"prompts"}`,
	} {
		w := apiRequest(a, "POST", "/api/files", body, a.cfg.Token)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "GET", "/api/prompts", "", a.cfg.Token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"name":"translate"`) {
		t.Fatal(w.Body.String())
	}
	for _, body := range []string{`{"operation":"read_file","path":"../config.json"}`, `{"operation":"shell"}`, `{} {}`, `{"unknown":true}`} {
		if w := apiRequest(a, "POST", "/api/files", body, a.cfg.Token); w.Code != 400 {
			t.Fatalf("accepted %s", body)
		}
	}
}

func TestInstallationTickets(t *testing.T) {
	a := testApp(t)
	content := "// ==UserScript==\n// @name Test\n// ==/UserScript==\nconsole.log('test');"
	if err := a.ws.write("userscripts/test.user.js", content); err != nil {
		t.Fatal(err)
	}
	w := apiRequest(a, "POST", "/api/install", `{"path":"userscripts/test.user.js"}`, a.cfg.Token)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result.URL, a.cfg.Token) {
		t.Fatal("pairing token leaked into URL")
	}
	r := httptest.NewRequest("GET", result.URL, nil)
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 200 || w.Body.String() != content {
		t.Fatalf("download = %d %s", w.Code, w.Body.String())
	}
	for key, ticket := range a.tickets {
		ticket.expires = time.Now().Add(-time.Second)
		a.tickets[key] = ticket
	}
	w = httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("expired ticket accepted")
	}
	w = apiRequest(a, "GET", "/install/unknown/boba.user.js", "", "")
	if w.Code != 401 {
		t.Fatal("missing ticket accepted")
	}
	w = apiRequest(a, "POST", "/api/install", `{"path":"output/test.user.js"}`, a.cfg.Token)
	if w.Code != 400 {
		t.Fatal("out-of-directory install accepted")
	}
}

func TestProxyControlsCredentialsAndModel(t *testing.T) {
	a := testApp(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+a.cfg.APIKey {
			t.Error("API credential missing")
		}
		if strings.Contains(r.Header.Get("Authorization"), a.cfg.Token) {
			t.Error("pairing token sent upstream")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["model"] != a.cfg.Model || body["stream"] != false {
			t.Errorf("upstream body = %+v", body)
		}
		respond(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "done"}, "finish_reason": "stop"}}})
	}))
	defer upstream.Close()
	a.upstream = upstream.URL
	w := apiRequest(a, "POST", "/v1/chat/completions", `{"messages":[{"role":"user","content":"hi"}],"tools":[]}`, a.cfg.Token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "done") {
		t.Fatal(w.Body.String())
	}
	w = apiRequest(a, "POST", "/v1/chat/completions", `{"model":"override","messages":[{}]}`, a.cfg.Token)
	if w.Code != 400 {
		t.Fatal("client overrode model")
	}
}

func TestProxyErrorsAndLimits(t *testing.T) {
	a := testApp(t)
	mode := "error"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode {
		case "error":
			fail(w, 429, "rate limited "+a.cfg.APIKey)
		case "html":
			w.WriteHeader(500)
			_, _ = io.WriteString(w, "<html>bad</html>")
		case "big":
			_, _ = w.Write(bytes.Repeat([]byte("x"), maxRequestBytes+1))
		case "redirect":
			http.Redirect(w, r, "https://example.com/", 302)
		}
	}))
	defer upstream.Close()
	a.upstream = upstream.URL
	for _, current := range []string{"error", "html", "big", "redirect"} {
		mode = current
		w := apiRequest(a, "POST", "/v1/chat/completions", `{"messages":[{"role":"user","content":"hi"}]}`, a.cfg.Token)
		if w.Code != 502 || strings.Contains(w.Body.String(), a.cfg.APIKey) {
			t.Fatalf("%s = %d %s", mode, w.Code, w.Body.String())
		}
	}
	w := apiRequest(a, "POST", "/api/files", `{"operation":"write_file","path":"x","content":"`+strings.Repeat("x", maxRequestBytes)+`"}`, a.cfg.Token)
	if w.Code != 400 {
		t.Fatalf("oversized request = %d", w.Code)
	}
}

func TestProxyCancellation(t *testing.T) {
	a := testApp(t)
	started, cancelled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer upstream.Close()
	a.upstream = upstream.URL
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest("POST", "http://127.0.0.1/v1/chat/completions", strings.NewReader(`{"messages":[{"role":"user","content":"hi"}]}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	done := make(chan struct{})
	go func() { defer close(done); a.handler().ServeHTTP(httptest.NewRecorder(), r) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not start")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("proxy did not return")
	}
}

func TestInitConfigExclusiveAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := initConfig(path); err != nil {
		t.Fatal(err)
	}
	if err := initConfig(path); err == nil {
		t.Fatal("overwrote existing config")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config permissions: %v %v", info, err)
	}
	if _, err := loadConfig(path); err == nil {
		t.Fatal("accepted unconfigured API key")
	}
}
