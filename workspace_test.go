package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWorkspace(t *testing.T) *workspace {
	t.Helper()
	base := t.TempDir()
	trash := filepath.Join(base, "Trash")
	if err := os.Mkdir(trash, 0o700); err != nil {
		t.Fatal(err)
	}
	ws, err := openWorkspace(filepath.Join(base, "workspace"), trash)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ws.Close() })
	return ws
}

func TestWorkspaceRoundTrip(t *testing.T) {
	ws := testWorkspace(t)
	for _, text := range []string{"hello 世界", "overwritten"} {
		if err := ws.write("output/nested/test.md", text); err != nil {
			t.Fatal(err)
		}
		got, err := ws.read("output/nested/test.md")
		if err != nil || got != text {
			t.Fatalf("read = %q, %v", got, err)
		}
	}
	list, err := ws.list(t.Context(), "output/nested")
	if err != nil || len(list) != 1 || list[0].Path != "output/nested/test.md" {
		t.Fatalf("list = %+v, %v", list, err)
	}
	result, err := ws.search(t.Context(), ".", "OVERWRITTEN")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), "overwritten") {
		t.Fatalf("search = %s", data)
	}
}

func TestWorkspaceEscape(t *testing.T) {
	ws := testWorkspace(t)
	outside := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ws.root.Symlink(filepath.Dir(outside), "escape"); err != nil {
		t.Fatal(err)
	}
	if err := ws.root.Symlink(outside, "secret-link"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../secret", outside, "escape/secret", "secret-link", "a/../../secret"} {
		t.Run(name, func(t *testing.T) {
			if _, err := ws.read(name); err == nil {
				t.Fatal("read escaped workspace")
			}
		})
	}
	for _, name := range []string{"../secret", outside, "escape/secret"} {
		if err := ws.write(name, "changed"); err == nil {
			t.Fatalf("write succeeded: %q", name)
		}
	}
	if _, err := ws.trash("escape/secret"); err == nil {
		t.Fatal("trash escaped workspace")
	}
	if _, err := ws.trash("secret-link"); err == nil {
		t.Fatal("trash accepted symlink")
	}
	// Atomic writes replace a final-component symlink instead of following it.
	if err := ws.write("secret-link", "local replacement"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(outside)
	if err != nil || string(data) != "secret" {
		t.Fatalf("outside changed: %q %v", data, err)
	}
}

func TestWorkspaceLimitsAndTrash(t *testing.T) {
	ws := testWorkspace(t)
	if err := ws.write("output/big", strings.Repeat("x", maxFileBytes+1)); err == nil {
		t.Fatal("oversize write accepted")
	}
	if err := ws.root.WriteFile("output/big", []byte(strings.Repeat("x", maxFileBytes+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.read("output/big"); err == nil {
		t.Fatal("oversize read accepted")
	}
	if err := ws.root.WriteFile("output/binary", []byte{0, 255}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ws.read("output/binary"); err == nil {
		t.Fatal("binary read accepted")
	}
	if err := ws.write("output/trash-me.md", "recoverable"); err != nil {
		t.Fatal(err)
	}
	name, err := ws.trash("output/trash-me.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ws.read("output/trash-me.md"); err == nil {
		t.Fatal("original still present")
	}
	data, err := os.ReadFile(filepath.Join(ws.trashPath, name))
	if err != nil || string(data) != "recoverable" {
		t.Fatalf("trash = %q, %v", data, err)
	}
	if _, err := ws.trash("output"); err == nil {
		t.Fatal("directory trash accepted")
	}
}

func TestTrashFailureKeepsOriginal(t *testing.T) {
	ws := testWorkspace(t)
	if err := ws.write("keep.txt", "keep"); err != nil {
		t.Fatal(err)
	}
	ws.trashPath = filepath.Join(t.TempDir(), "missing-trash")
	if _, err := ws.trash("keep.txt"); err == nil {
		t.Fatal("expected failure")
	}
	if got, err := ws.read("keep.txt"); err != nil || got != "keep" {
		t.Fatalf("original lost: %q %v", got, err)
	}
}

func TestPromptSearchDoesNotFollowLinks(t *testing.T) {
	ws := testWorkspace(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "password.txt"), []byte("sensitive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ws.root.Symlink(outside, "linked"); err != nil {
		t.Fatal(err)
	}
	result, err := ws.search(t.Context(), ".", "sensitive")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "password") {
		t.Fatalf("search followed external symlink: %s", data)
	}
}
