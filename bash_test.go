package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func requireMacSandbox(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" {
		t.Skip("macOS Seatbelt integration")
	}
}

func TestBashWorkspaceAndEnvironment(t *testing.T) {
	requireMacSandbox(t)
	ws := testWorkspace(t)
	t.Setenv("BOBA_SECRET_TEST", "do-not-inherit")
	result, err := ws.bash(t.Context(), `printf '%s\n' "$PWD" "$HOME" "$TMPDIR" "${BOBA_SECRET_TEST-unset}"; printf 'hello 世界' > output/shell.txt; cat output/shell.txt`, 5)
	if err != nil || result.ExitCode != 0 || !strings.Contains(result.Output, "unset\nhello 世界") || strings.Contains(result.Output, "do-not-inherit") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	text, err := ws.read("output/shell.txt")
	if err != nil || text != "hello 世界" {
		t.Fatalf("file=%q err=%v", text, err)
	}
}

func TestBashDeniesPrivateFilesSymlinksNetworkAndMach(t *testing.T) {
	requireMacSandbox(t)
	ws := testWorkspace(t)
	outside := filepath.Join(t.TempDir(), "private.txt")
	if err := os.WriteFile(outside, []byte("private-secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ws.root.Symlink(filepath.Dir(outside), "escape"); err != nil {
		t.Fatal(err)
	}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("network-should-be-denied")) }))
	defer target.Close()
	commands := []string{
		fmt.Sprintf("cat %q", outside),
		fmt.Sprintf("stat %q", outside),
		`/bin/ps eww -p "$PPID"`,
		"cat escape/private.txt",
		fmt.Sprintf("printf changed > %q", outside),
		"printf changed > escape/private.txt",
		"curl --noproxy '*' --connect-timeout 1 " + target.URL,
		"/usr/bin/nc -z -w 1 127.0.0.1 " + strings.TrimPrefix(target.URL, "http://127.0.0.1:"),
		`kill -0 "$PPID"`,
		"/bin/launchctl list",
	}
	for _, command := range commands {
		t.Run(command, func(t *testing.T) {
			result, err := ws.bash(t.Context(), command, 5)
			if err != nil || result.ExitCode == 0 || (strings.Contains(result.Output, "private-secret") || strings.Contains(result.Output, "network-should-be-denied")) {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "private-secret" {
		t.Fatalf("outside=%q err=%v", data, err)
	}
}

func TestBashOutputExitAndTimeout(t *testing.T) {
	requireMacSandbox(t)
	ws := testWorkspace(t)
	result, err := ws.bash(t.Context(), "printf problem >&2; exit 7", 5)
	if err != nil || result.ExitCode != 7 || !strings.Contains(result.Output, "problem") {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	result, err = ws.bash(t.Context(), "yes x | head -c 40000", 5)
	if err != nil || !result.Truncated || len(result.Output) > maxBashOutput {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	result, err = ws.bash(t.Context(), `for ((i=0;i<10000;i++)); do printf '\001'; done`, 5)
	data, _ := json.Marshal(result)
	if err != nil || !result.Truncated || len(data) > 24000 {
		t.Fatalf("serialized=%d truncated=%v err=%v", len(data), result.Truncated, err)
	}
	started := time.Now()
	result, err = ws.bash(t.Context(), "sleep 20 & wait", 1)
	if err != nil || !result.TimedOut || result.ExitCode == 0 || time.Since(started) > 4*time.Second {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestBashCancellationKillsProcessGroup(t *testing.T) {
	requireMacSandbox(t)
	ws := testWorkspace(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan bashResult, 1)
	go func() {
		result, _ := ws.bash(ctx, `printf started > output/started; (sleep 2; printf escaped > output/escaped) & wait`, 10)
		done <- result
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := ws.read("output/started"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("shell did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case result := <-done:
		if !result.Cancelled {
			t.Fatalf("result=%+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not return")
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := ws.read("output/escaped"); !os.IsNotExist(err) {
		t.Fatalf("background child survived: %v", err)
	}
}

func TestBashReplacedWorkspaceIsRejected(t *testing.T) {
	requireMacSandbox(t)
	ws := testWorkspace(t)
	name := ws.root.Name()
	if err := os.Rename(name, name+"-moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(name, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.bash(t.Context(), "printf bad > unexpected", 5); err == nil {
		t.Fatal("replaced workspace accepted")
	}
	if _, err := os.Stat(filepath.Join(name, "unexpected")); !os.IsNotExist(err) {
		t.Fatalf("replacement was modified: %v", err)
	}
}

func TestBashAPIRequestCancellation(t *testing.T) {
	requireMacSandbox(t)
	a := testApp(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest("POST", "http://127.0.0.1/api/bash", strings.NewReader(`{"command":"printf started > output/api-started; (sleep 2; printf escaped > output/api-escaped) & wait","timeout":10}`)).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	done := make(chan struct{})
	go func() { defer close(done); a.handler().ServeHTTP(httptest.NewRecorder(), r) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := a.ws.read("output/api-started"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("API shell did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("API cancellation did not propagate")
	}
	time.Sleep(2200 * time.Millisecond)
	if _, err := a.ws.read("output/api-escaped"); !os.IsNotExist(err) {
		t.Fatalf("API child survived cancellation: %v", err)
	}
}

func TestBashAPIAuthenticationAndValidation(t *testing.T) {
	a := testApp(t)
	if w := apiRequest(a, "POST", "/api/bash", `{"command":"echo denied"}`, ""); w.Code != 401 {
		t.Fatalf("unauthenticated=%d", w.Code)
	}
	for _, body := range []string{`{"command":"echo x","env":{}}`, `{"command":""}`, `{"command":"echo x","timeout":121}`, `{"command":"echo x","timeout":-1}`} {
		if w := apiRequest(a, "POST", "/api/bash", body, a.cfg.Token); w.Code != 400 {
			t.Fatalf("accepted %s: %d", body, w.Code)
		}
	}
	if runtime.GOOS != "darwin" {
		if _, err := a.ws.bash(t.Context(), "echo x", 1); err == nil {
			t.Fatal("unsupported platform allowed shell")
		}
		return
	}
	w := apiRequest(a, "POST", "/api/bash", `{"command":"printf endpoint"}`, a.cfg.Token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "endpoint") {
		t.Fatalf("endpoint=%d %s", w.Code, w.Body.String())
	}
}
