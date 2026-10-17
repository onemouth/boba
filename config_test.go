package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMaxTokensConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name    string
		value   any
		want    int
		invalid bool
	}{
		{name: "omitted", want: 16384},
		{name: "zero uses default", value: 0, want: 16384},
		{name: "custom", value: 32768, want: 32768},
		{name: "negative", value: -1, invalid: true},
		{name: "fractional", value: 1.5, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values := map[string]any{"api_key": "test-secret", "model": "test/model", "port": 8787, "pairing_token": "test-pairing-token-123456789"}
			if tc.value != nil {
				values["max_tokens"] = tc.value
			}
			data, err := json.Marshal(values)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, data, 0o600); err != nil {
				t.Fatal(err)
			}
			cfg, err := loadConfig(path)
			if tc.invalid {
				if err == nil {
					t.Fatal("accepted invalid max_tokens")
				}
				return
			}
			if err != nil || cfg.MaxTokens != tc.want {
				t.Fatalf("max_tokens = %d, error %v; want %d", cfg.MaxTokens, err, tc.want)
			}
		})
	}
}

func TestProxyUsesConfiguredOutputBudget(t *testing.T) {
	for _, limit := range []int{16384, 32768} {
		a := testApp(t)
		a.cfg.MaxTokens = limit
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				MaxTokens int `json:"max_tokens"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body.MaxTokens != limit {
				t.Errorf("got %d, want %d", body.MaxTokens, limit)
			}
			respond(w, 200, map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "done"}}}})
		}))
		a.upstream = upstream.URL
		w := apiRequest(a, "POST", "/v1/chat/completions", `{"messages":[{"role":"user","content":"hi"}]}`, a.cfg.Token)
		upstream.Close()
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	if got := testApp(t).cfg.MaxTokens; got != 16384 {
		t.Fatalf("default = %d", got)
	}
}
