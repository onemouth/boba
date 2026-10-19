package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEditExactReplacementAndRejections(t *testing.T) {
	ws := testWorkspace(t)
	if err := ws.write("output/edit.txt", "保留\nold text\n尾端"); err != nil {
		t.Fatal(err)
	}
	if err := ws.edit("output/edit.txt", "old text", "new 世界"); err != nil {
		t.Fatal(err)
	}
	text, err := ws.read("output/edit.txt")
	if err != nil || text != "保留\nnew 世界\n尾端" {
		t.Fatalf("text=%q err=%v", text, err)
	}
	for _, input := range []struct{ path, old, new string }{
		{"output/edit.txt", "", "oops"},
		{"output/edit.txt", "missing", "oops"},
		{"output/edit.txt", "保留", strings.Repeat("x", maxFileBytes)},
		{"output/edit.txt", "保留", "\x00"},
		{"../outside", "old", "new"},
		{"missing.txt", "old", "new"},
	} {
		if err := ws.edit(input.path, input.old, input.new); err == nil {
			t.Fatalf("accepted %+v", input)
		}
	}
	if after, _ := ws.read("output/edit.txt"); after != text {
		t.Fatal("rejection changed the file")
	}
	for _, value := range []string{"twice twice", "aaa"} {
		if err := ws.write("ambiguous", value); err != nil {
			t.Fatal(err)
		}
		old := "twice"
		if value == "aaa" {
			old = "aa"
		}
		if err := ws.edit("ambiguous", old, "new"); err == nil {
			t.Fatal("ambiguous match accepted")
		}
	}
	if err := ws.root.Symlink("output/edit.txt", "alias"); err != nil {
		t.Fatal(err)
	}
	if err := ws.edit("alias", "保留", "wrong"); err == nil {
		t.Fatal("final symlink accepted")
	}
	if err := ws.edit("output/edit.txt", "new 世界", ""); err != nil {
		t.Fatal(err)
	}
	if got, _ := ws.read("output/edit.txt"); got != "保留\n\n尾端" {
		t.Fatalf("delete=%q", got)
	}
}

func TestEditAPI(t *testing.T) {
	a := testApp(t)
	if err := a.ws.write("output/test", "original"); err != nil {
		t.Fatal(err)
	}
	input := map[string]string{"operation": "edit_file", "path": "output/test", "old_text": "original", "new_text": "changed"}
	body, _ := json.Marshal(input)
	if w := apiRequest(a, "POST", "/api/files", string(body), ""); w.Code != 401 {
		t.Fatal("edit authentication bypass")
	}
	w := apiRequest(a, "POST", "/api/files", string(body), a.cfg.Token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"edited":"output/test"`) {
		t.Fatalf("edit=%d %s", w.Code, w.Body.String())
	}
	w = apiRequest(a, "POST", "/api/files", string(body), a.cfg.Token)
	if w.Code != 400 {
		t.Fatal("stale edit accepted")
	}
}
