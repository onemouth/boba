package main

// Opt-in subprocess fixture for the Chromium test. Uses temporary workspace and
// a deterministic fake OpenRouter; never reads config.json or calls the network.
import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestDevtoolsBrowserFixture(t *testing.T) {
	if os.Getenv("BOBA_BROWSER_FIXTURE") != "1" {
		t.Skip("Chromium subprocess fixture only")
	}
	a := testApp(t)
	a.cfg.Model = "test/devtools"
	var cancelled atomic.Bool
	var wrongContext atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			fail(w, 400, err.Error())
			return
		}
		latest, userIndex := "", 0
		for i, message := range input.Messages {
			if message.Role == "user" {
				userIndex = i
				_ = json.Unmarshal(message.Content, &latest)
			}
		}
		if strings.Contains(latest, "Current page: http://127.0.0.1:") && strings.Contains(strings.Split(latest, "\n")[0], "/devtools/") {
			wrongContext.Store(true)
		}
		if strings.Contains(latest, "wait-for-stop") {
			<-r.Context().Done()
			cancelled.Store(true)
			return
		}
		step := 0
		for _, message := range input.Messages[userIndex+1:] {
			if message.Role == "assistant" {
				step++
			}
		}
		call := func(id, name string, args any) map[string]any {
			data, _ := json.Marshal(args)
			return map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(data)}}
		}
		message := map[string]any{"role": "assistant", "content": "Done"}
		if step == 0 {
			message["content"] = nil
			message["tool_calls"] = []any{call("inspect", "inspect_page", map[string]any{})}
		} else if step == 1 {
			message["content"] = nil
			if strings.Contains(latest, "follow-up") {
				message["tool_calls"] = []any{call("refine", "type", map[string]any{"selector": "#notes", "text": "Follow-up kept the name"})}
			} else {
				message["tool_calls"] = []any{
					call("type", "type", map[string]any{"selector": "#name", "text": "Boba"}),
					call("edit", "execute_javascript", map[string]any{"code": "document.querySelector('#sidebar').style.display='none'; return {hidden:true};"}),
					call("save", "write_file", map[string]any{"path": "output/devtools-smoke.md", "content": "# DevTools smoke\n\nSaved from the protected controller.\n"}),
				}
			}
		}
		respond(w, 200, map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": message}}})
	}))
	defer upstream.Close()
	a.upstream = upstream.URL
	mux := http.NewServeMux()
	mux.HandleFunc("GET /fixture/status", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"cancelled": cancelled.Load(), "wrong_context": wrongContext.Load()})
	})
	mux.Handle("/", a.handler())
	server := httptest.NewUnstartedServer(mux)
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	a.cfg.Port, _ = strconv.Atoi(port)
	server.Start()
	defer server.Close()
	fmt.Printf("BOBA_FIXTURE_READY %s\n", server.URL)
	_, _ = io.Copy(io.Discard, os.Stdin)
}
