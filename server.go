package main

import (
	"bytes"
	"cmp"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

//go:embed userscript/boba.user.js
var userscript string

const maxRequestBytes = 4 << 20

type installTicket struct {
	content string
	expires time.Time
}

type app struct {
	cfg      config
	ws       *workspace
	client   *http.Client
	upstream string
	mu       sync.Mutex
	tickets  map[string]installTicket
}

func newApp(cfg config, ws *workspace) *app {
	cfg.MaxTokens = cmp.Or(cfg.MaxTokens, defaultMaxTokens)
	return &app{cfg: cfg, ws: ws, upstream: "https://openrouter.ai/api/v1/chat/completions",
		client:  &http.Client{Timeout: 150 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }},
		tickets: make(map[string]installTicket)}
}

func (a *app) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /devtools/{$}", a.devtools)
	mux.HandleFunc("GET /devtools/{asset}", a.devtools)
	mux.HandleFunc("GET /api/health", a.auth(func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"ok": true, "model": a.cfg.Model, "max_tokens": a.cfg.MaxTokens, "workspace": "~/Documents/boba"})
	}))
	mux.HandleFunc("POST /v1/chat/completions", a.auth(a.chat))
	mux.HandleFunc("POST /api/files", a.auth(a.files))
	mux.HandleFunc("POST /api/bash", a.auth(a.bash))
	mux.HandleFunc("GET /api/prompts", a.auth(a.prompts))
	mux.HandleFunc("POST /api/install", a.auth(a.install))
	mux.HandleFunc("GET /api/userscript", a.auth(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = io.WriteString(w, userscript)
	}))
	mux.HandleFunc("GET /install/{ticket}/boba.user.js", a.download)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "127.0.0.1" && host != "localhost" {
			fail(w, 403, "invalid Host header")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+a.cfg.Token)) != 1 {
			fail(w, 401, "pairing token required")
			return
		}
		next(w, r)
	}
}

func decode(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON object")
	}
	return nil
}

func respond(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, code int, message string) {
	respond(w, code, map[string]any{"error": map[string]string{"message": message}})
}

func (a *app) chat(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Messages []json.RawMessage `json:"messages"`
		Tools    []json.RawMessage `json:"tools"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if len(input.Messages) == 0 || len(input.Messages) > 400 || len(input.Tools) > 30 {
		fail(w, 400, "invalid message/tool count")
		return
	}
	payload := map[string]any{"model": a.cfg.Model, "messages": input.Messages, "tools": input.Tools,
		"stream": false, "max_tokens": a.cfg.MaxTokens, "tool_choice": "auto"}
	data, err := json.Marshal(payload)
	if err != nil {
		fail(w, 400, "invalid JSON")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), "POST", a.upstream, bytes.NewReader(data))
	if err != nil {
		fail(w, 500, "cannot create upstream request")
		return
	}
	request.Header.Set("Authorization", "Bearer "+a.cfg.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-OpenRouter-Title", "Boba")
	response, err := a.client.Do(request)
	if err != nil {
		fail(w, 502, "OpenRouter request failed or was cancelled")
		return
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxRequestBytes+1))
	if err != nil || len(body) > maxRequestBytes {
		fail(w, 502, "OpenRouter response unreadable or too large")
		return
	}
	if !json.Valid(body) {
		fail(w, 502, fmt.Sprintf("OpenRouter returned non-JSON (HTTP %d)", response.StatusCode))
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Do not pass through provider headers or request metadata.
		var upstream struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &upstream)
		message := strings.ReplaceAll(upstream.Error.Message, a.cfg.APIKey, "[redacted]")
		fail(w, 502, fmt.Sprintf("OpenRouter HTTP %d: %s", response.StatusCode, truncateUTF8(message, 1000)))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func (a *app) files(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Operation string `json:"operation"`
		Path      string `json:"path"`
		Content   string `json:"content"`
		Query     string `json:"query"`
		OldText   string `json:"old_text"`
		NewText   string `json:"new_text"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, 400, err.Error())
		return
	}
	var result any
	var err error
	switch input.Operation {
	case "list_files":
		result, err = a.ws.list(r.Context(), input.Path)
	case "read_file":
		result, err = a.ws.read(input.Path)
	case "write_file":
		err = a.ws.write(input.Path, input.Content)
		result = map[string]any{"written": input.Path}
	case "edit_file":
		err = a.ws.edit(input.Path, input.OldText, input.NewText)
		result = map[string]any{"edited": input.Path}
	case "search_files":
		result, err = a.ws.search(r.Context(), input.Path, input.Query)
	case "trash_file":
		result, err = a.ws.trash(input.Path)
	default:
		err = errors.New("unknown file operation")
	}
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	respond(w, 200, map[string]any{"result": result})
}

func (a *app) prompts(w http.ResponseWriter, r *http.Request) {
	type prompt struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	result := []prompt{}
	visited := 0
	err := fs.WalkDir(a.ws.root.FS(), "prompts", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := r.Context().Err(); err != nil {
			return err
		}
		visited++
		if visited > 1000 {
			return errors.New("too many prompt entries")
		}
		if !d.IsDir() && d.Type().IsRegular() && strings.HasSuffix(p, ".md") {
			result = append(result, prompt{Name: strings.TrimSuffix(strings.TrimPrefix(p, "prompts/"), ".md"), Path: p})
		}
		return nil
	})
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	respond(w, 200, map[string]any{"prompts": result})
}

func (a *app) install(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Path string `json:"path"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !strings.HasPrefix(input.Path, "userscripts/") || !strings.HasSuffix(input.Path, ".user.js") {
		fail(w, 400, "choose a userscripts/*.user.js file")
		return
	}
	content, err := a.ws.read(input.Path)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !strings.HasPrefix(strings.TrimSpace(content), "// ==UserScript==") || !strings.Contains(content, "// ==/UserScript==") {
		fail(w, 400, "userscript metadata block missing")
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for key, ticket := range a.tickets {
		if time.Now().After(ticket.expires) {
			delete(a.tickets, key)
		}
	}
	if len(a.tickets) >= 32 {
		fail(w, 429, "too many installation tickets; wait five minutes")
		return
	}
	key := rand.Text()
	a.tickets[key] = installTicket{content: content, expires: time.Now().Add(5 * time.Minute)}
	// A short-lived capability, not the main pairing token. Multiple reads are
	// allowed because userscript managers may fetch the URL more than once.
	respond(w, 200, map[string]any{"url": fmt.Sprintf("http://127.0.0.1:%d/install/%s/boba.user.js", a.cfg.Port, key), "expires_in": 300})
}

func (a *app) download(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	ticket, ok := a.tickets[r.PathValue("ticket")]
	a.mu.Unlock()
	if !ok || time.Now().After(ticket.expires) {
		fail(w, 401, "invalid or expired installation ticket")
		return
	}
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	_, _ = io.WriteString(w, ticket.content)
}
