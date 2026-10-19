# Workspace editing and sandboxed bash (0.1.7+)

The agent exposes the Pi-style core capabilities as `read_file`, `write_file`, `edit_file`, and `bash`, alongside existing page/workspace tools. Both userscript and DevTools controller dispatch these host operations directly to the authenticated Go server. Target-page RPC cannot call host capabilities.

Update to userscript **0.1.7**, reload the page, and restart `go run . serve`. DevTools users must restart the server for updated embedded assets and replace/rerun the generated snippet as usual. Existing pairing credentials and custom shortcuts are retained. No workspace prompts are modified.

## `edit_file`

```json
{"path":"output/report.md","old_text":"Exact existing paragraph","new_text":"Revised paragraph"}
```

- Existing regular UTF-8 file, at most 1 MiB; paths remain workspace-relative and protected by `os.Root`.
- Exactly one literal match, including whitespace. Missing, duplicate and overlapping matches are rejected without writing. Read again and supply more context rather than retrying a guessed replacement.
- Empty `new_text` deletes the matched text. Empty `old_text` is rejected.
- Final-component symlinks, directories, binary/NUL input and oversized results are rejected.
- Read/check/write is serialized against the server's write/edit/trash operations and replacement is atomic. This is not a compare-and-swap transaction against external editors or concurrent shell processes.
- `/api/files` operation `edit_file` returns `{ "result": { "edited": "output/report.md" } }` on acknowledgement.

## `bash`

```json
{"command":"printf 'name,value\\nexample,1\\n' > output/data.csv; sort output/data.csv","timeout":10}
```

Authenticated `POST /api/bash` takes `command` and optional `timeout`. Commands run automatically with no approval prompt. The default timeout is 60 seconds, permitted range 1–120. Each call starts a fresh noninteractive `/bin/bash --noprofile --norc`; shell variables/cwd do not persist between calls.

### OS-enforced boundary

This implementation is **macOS-only**, using `/usr/bin/sandbox-exec` with a deny-default Seatbelt profile. It does not merely set cwd or validate command strings. Unsupported platforms, missing executables and sandbox startup errors never fall back to unrestricted execution. Apple has deprecated sandbox-exec; future OS compatibility is not guaranteed.

- Workspace is both the initial cwd and the only permitted user-data read/write tree. Symlink targets outside it are denied by OS policy. A replaced workspace directory is rejected before launch.
- A narrow set of standard system executable/runtime trees is readable, including `/bin`, `/usr/bin`, system libraries and shared runtime data. Listing the filesystem root is permitted for runtime startup; private-file contents and metadata outside allowed paths are not generally accessible. This is not a chroot, and public OS files remain visible.
- No network access, **including localhost**. No general Mach/GUI automation service access or process/environment introspection permission is granted. Children inherit the OS sandbox.
- A fresh environment contains only a fixed system PATH, workspace HOME/TMPDIR, locale and TERM. Server environment variables, pairing tokens and API keys are not inherited. Keep `config.json` outside the workspace as before.
- Standard shell builtins, pipes, redirection and basic system tools such as `cat`, `sort`, `sed` and `awk` are the initial supported environment. Homebrew installations, Xcode tools, Python/Node package trees, system temp directories and per-user configuration outside the workspace are **not** automatically allowlisted. A system binary being present does not guarantee all its dependencies/features work. Do not broaden policy in response to generated commands automatically.
- Workspace executables may run if their interpreters/runtime dependencies are available under that same policy. HOME/TMPDIR point to the workspace; tools should use these instead of assuming `/tmp` is writable.

### Effects, output and Stop

Results contain `output` (combined stdout/stderr), `exit_code`, `truncated`, `timed_out` and `cancelled`. Output is drained but retained only up to 16,000 bytes, with an additional serialized-JSON budget for control characters. Invalid UTF-8 is replaced. Large results must be saved to workspace files and read in chunks; there is no automatic full-log transcript file.

Nonzero exit, timeout or cancellation can leave partial effects. The execution ledger marks those operations **uncertain**, retains returned diagnostics in model history, and blocks conflicting workspace mutations until user review. Reads remain possible for inspection. Exit 0 is an acknowledgement, not independent proof of task success or absence of background work. Tool-argument bodies (commands/replacement text) and shell output are not copied into the progress ledger; user-instruction excerpts can still contain sensitive text, and model/tool history retains arguments/results.

Stop aborts the HTTP request; request cancellation/timeout kills the shell's process group. Remaining same-group children are also killed after normal completion, and an inherited-output-pipe timeout bounds waiting for background processes. **Detached children that create a new session/process group are not guaranteed to stop.** They remain sandboxed, but this is not a VM, fork-bomb protection, disk/memory quota, or full resource-isolation service. Do not run persistent daemons or untrusted workloads requiring those guarantees.

**Deletion is different from `trash_file`: shell `rm`, truncation and other writes can permanently destroy workspace data.** The OS sandbox restricts where these effects can occur; it does not convert them into Trash operations. Prefer `trash_file` for intentional file deletion. Only that dedicated tool guarantees its existing copy-to-Trash behavior.

Sandboxing host commands does not sandbox browser JavaScript or solve prompt injection. Malicious instructions can still cause unwanted actions within allowed browser/workspace capabilities. Use trusted pages and keep sensitive material out of the workspace. Files already present there, including hardlinks sharing an inode with an outside file, are in the allowed data scope; do not populate it with hardlinks to sensitive external data.

## Tests

macOS integration tests execute the actual OS sandbox against temporary workspaces: permitted file processing, denied private paths/metadata and symlink escapes, a denied connection to a live loopback server, denied system-service access, stripped environment, output bounds, exit codes, timeout and process-group cancellation. Go tests never use the real Trash/configuration.

JS tests cover schemas, host dispatch, failed-shell diagnostics, uncertainty/replay guards, Stop and progress privacy. Chromium tests run the real localhost Go controller and actual sandbox/edit operations with a mocked model. No paid model calls or compatibility guarantees for every macOS version/toolchain are implied.
