package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

const maxFileBytes = 1 << 20

// os.Root provides traversal-resistant operations, including symlink resolution.
type workspace struct {
	root      *os.Root
	trashPath string
	mu        sync.Mutex
}

func openWorkspace(dir, trash string) (*workspace, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"prompts", "output", "userscripts"} {
		if err := r.MkdirAll(name, 0o700); err != nil {
			r.Close()
			return nil, err
		}
	}
	return &workspace{root: r, trashPath: trash}, nil
}

func (w *workspace) Close() error { return w.root.Close() }

func localPath(name string) (string, error) {
	if name == "" {
		return ".", nil
	}
	if strings.ContainsRune(name, '\\') || !fs.ValidPath(name) || !filepath.IsLocal(name) {
		return "", errors.New("path must be workspace-relative without ..")
	}
	return name, nil
}

func (w *workspace) read(name string) (string, error) {
	name, err := localPath(name)
	if err != nil {
		return "", err
	}
	info, err := w.root.Stat(name)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("only regular text files are supported")
	}
	f, err := w.root.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > maxFileBytes {
		return "", errors.New("file exceeds 1 MiB limit")
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		return "", errors.New("file is not UTF-8 text")
	}
	return string(data), nil
}

func (w *workspace) write(name, content string) error {
	name, err := localPath(name)
	if err != nil {
		return err
	}
	if name == "." || len(content) > maxFileBytes {
		return errors.New("invalid filename or content exceeds 1 MiB")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.root.MkdirAll(path.Dir(name), 0o700); err != nil {
		return err
	}
	// Atomic replacement also avoids following an existing final-component symlink.
	tmp := path.Join(path.Dir(name), ".boba-"+rand.Text())
	f, err := w.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer w.root.Remove(tmp)
	_, writeErr := io.WriteString(f, content)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return w.root.Rename(tmp, name)
}

type fileEntry struct {
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
	Size      int64  `json:"size"`
}

func (w *workspace) list(ctx context.Context, name string) ([]fileEntry, error) {
	name, err := localPath(name)
	if err != nil {
		return nil, err
	}
	f, err := w.root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	entries, err := f.ReadDir(501)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	if len(entries) > 500 {
		return nil, errors.New("directory exceeds 500 entries; choose a smaller directory")
	}
	result := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		result = append(result, fileEntry{Path: path.Join(name, entry.Name()), Directory: entry.IsDir(), Size: info.Size()})
	}
	return result, nil
}

func (w *workspace) search(ctx context.Context, name, query string) (any, error) {
	name, err := localPath(name)
	if err != nil {
		return nil, err
	}
	if query == "" {
		return nil, errors.New("query cannot be empty")
	}
	type match struct {
		Path string `json:"path"`
		Line int    `json:"line"`
		Text string `json:"text"`
	}
	matches := []match{}
	visited, bytesRead, truncated := 0, 0, false
	needle := strings.ToLower(query)
	err = fs.WalkDir(w.root.FS(), name, func(p string, d fs.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		visited++
		if visited > 2000 || bytesRead > 8<<20 || len(matches) >= 100 {
			truncated = true
			return fs.SkipAll
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if strings.Contains(strings.ToLower(p), needle) {
			matches = append(matches, match{Path: p})
		}
		text, err := w.read(p)
		if err != nil {
			return nil
		} // Skip binary, unreadable, and oversized files.
		bytesRead += len(text)
		line := 0
		for textLine := range strings.SplitSeq(text, "\n") {
			line++
			if strings.Contains(strings.ToLower(textLine), needle) {
				matches = append(matches, match{Path: p, Line: line, Text: truncateUTF8(textLine, 300)})
				if len(matches) >= 100 {
					truncated = true
					return fs.SkipAll
				}
			}
		}
		return nil
	})
	return map[string]any{"matches": matches, "truncated": truncated}, err
}

// Copy to the user's real macOS Trash, then remove the original only after a
// successful sync/close. No Finder automation or shell execution is required.
// Only regular files are supported; this is intentionally not recursive deletion.
func (w *workspace) trash(name string) (string, error) {
	name, err := localPath(name)
	if err != nil {
		return "", err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	info, err := w.root.Lstat(name)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("trash_file accepts regular files only, not directories or symlinks")
	}
	source, err := w.root.Open(name)
	if err != nil {
		return "", err
	}
	defer source.Close()
	info, err = source.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 32<<20 {
		return "", errors.New("trash supports regular files up to 32 MiB")
	}
	// Do not create arbitrary trash destinations; on macOS this is ~/.Trash.
	trash, err := os.OpenRoot(w.trashPath)
	if err != nil {
		return "", fmt.Errorf("open macOS Trash: %w", err)
	}
	defer trash.Close()
	dest := filepath.Base(name) + ".boba-" + rand.Text()
	out, err := trash.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm()&0o600)
	if err != nil {
		return "", err
	}
	n, copyErr := io.Copy(out, io.LimitReader(source, (32<<20)+1))
	if n > 32<<20 {
		copyErr = errors.New("file grew beyond trash limit")
	}
	err = errors.Join(copyErr, out.Sync(), out.Close())
	if err == nil {
		err = w.root.Remove(name)
	}
	if err != nil {
		_ = trash.Remove(dest)
		return "", err
	}
	return dest, nil
}

func truncateUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit]
}
