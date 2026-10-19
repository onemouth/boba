package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const maxBashOutput = 16000

// Seatbelt is a macOS-only, deny-default policy. System runtime files are
// readable; user data is readable/writable only beneath the workspace.
// No network, arbitrary Mach service access, or inherited environment is allowed.
const bashSandbox = `(version 1)
(deny default)
(allow process-exec (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin") (subpath (param "WORKSPACE")))
(allow process-fork)
(allow signal (target same-sandbox))
(allow file-read*
 (literal "/")
 (subpath "/bin") (subpath "/sbin") (subpath "/usr/bin") (subpath "/usr/sbin")
 (subpath "/usr/lib") (subpath "/usr/share")
 (subpath "/System/Library") (subpath "/System/Cryptexes")
 (subpath "/System/Volumes/Preboot/Cryptexes") (subpath "/Library/Apple")
 (subpath "/private/var/db/dyld")
 (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
 (subpath (param "WORKSPACE")))
(allow file-write* (literal "/dev/null") (subpath (param "WORKSPACE")))`

type bashResult struct {
	Output    string `json:"output"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated"`
	TimedOut  bool   `json:"timed_out"`
	Cancelled bool   `json:"cancelled"`
}

type cappedOutput struct {
	mu        sync.Mutex
	data      []byte
	truncated bool
}

func (b *cappedOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := min(len(p), maxBashOutput-len(b.data))
	b.data = append(b.data, p[:n]...)
	b.truncated = b.truncated || n < len(p)
	return len(p), nil // Keep draining: a full output buffer must not stall the child.
}

func (w *workspace) bash(ctx context.Context, command string, timeout int) (bashResult, error) {
	if runtime.GOOS != "darwin" {
		return bashResult{}, errors.New("sandboxed bash requires macOS sandbox-exec; unrestricted fallback is disabled")
	}
	if strings.TrimSpace(command) == "" || len(command) > 64000 || strings.ContainsRune(command, 0) {
		return bashResult{}, errors.New("command must contain 1–64000 bytes without NUL")
	}
	if timeout == 0 {
		timeout = 60
	}
	if timeout < 1 || timeout > 120 {
		return bashResult{}, errors.New("timeout must be 1–120 seconds")
	}
	dir, err := filepath.Abs(w.root.Name())
	if err != nil {
		return bashResult{}, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return bashResult{}, err
	}
	original, err := w.root.Stat(".")
	if err != nil {
		return bashResult{}, err
	}
	current, err := os.Stat(dir)
	if err != nil {
		return bashResult{}, err
	}
	if !os.SameFile(original, current) {
		return bashResult{}, errors.New("workspace was replaced; restart the server")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", "-D", "WORKSPACE="+dir, "-p", bashSandbox, "/bin/bash", "--noprofile", "--norc", "-c", command)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + dir, "TMPDIR=" + dir, "LANG=en_US.UTF-8", "TERM=dumb"}
	configureBashProcess(cmd)
	cmd.WaitDelay = time.Second
	var output cappedOutput
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		return bashResult{}, errors.New("cannot start macOS sandbox; unrestricted fallback is disabled")
	}
	defer killBashGroup(cmd)
	err = cmd.Wait()
	exitCode := -1
	if cmd.ProcessState != nil {
		exitCode = cmd.ProcessState.ExitCode()
	}
	result := bashResult{Output: strings.ToValidUTF8(string(output.data), "�"), ExitCode: exitCode, Truncated: output.truncated, TimedOut: errors.Is(ctx.Err(), context.DeadlineExceeded), Cancelled: errors.Is(ctx.Err(), context.Canceled)}
	if errors.Is(err, exec.ErrWaitDelay) {
		result.Output += "\n[Background process kept output open; process group stopped.]"
		if result.ExitCode == 0 {
			result.ExitCode = -1
		}
	}
	// Bound serialized JSON too: control characters can expand sixfold.
	for {
		encoded, _ := json.Marshal(result.Output)
		if len(encoded) <= 18000 {
			break
		}
		result.Output = truncateUTF8(result.Output, len(result.Output)/2)
		result.Truncated = true
	}
	return result, nil
}

func (a *app) bash(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if err := decode(w, r, &input); err != nil {
		fail(w, 400, err.Error())
		return
	}
	result, err := a.ws.bash(r.Context(), input.Command, input.Timeout)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	respond(w, 200, map[string]any{"result": result})
}
