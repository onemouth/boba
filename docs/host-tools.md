# File tools and shell sandbox

Host tools are available through both browser entry points. They call the authenticated Go server directly, never through target-page RPC. File paths are relative to `~/Documents/boba`.

| Tool | Behavior |
| --- | --- |
| `list_files` | List up to 500 directory entries. |
| `search_files` | Search text and filenames with bounded results. |
| `read_file` | Read a UTF-8 file up to 1 MiB; use `offset`/`limit` for chunks. |
| `write_file` | Create or overwrite up to 1 MiB atomically; create parent directories. Does not append. |
| `edit_file` | Replace one unique literal match atomically. |
| `trash_file` | Copy a regular file up to 32 MiB to macOS Trash, then remove the source after sync. No directories or symlinks; copy failures preserve the original. |
| `bash` | Run a shell command inside the macOS workspace sandbox. |

## Exact editing

```json
{"path":"output/report.md","old_text":"Exact existing paragraph","new_text":"Revised paragraph"}
```

Read the file first. Missing, duplicate or overlapping matches are rejected without writing; include more context rather than guessing. Empty `old_text` is invalid; empty `new_text` deletes the match. Files must be regular UTF-8 text, with no NUL, and fit the 1 MiB limit. Final-component symlinks are rejected.

Read/check/write is serialized against the server's write/edit/trash operations. Atomic replacement does not provide compare-and-swap protection against external editors or concurrent shell processes.

## Sandboxed bash

```json
{"command":"printf 'name,value\\nexample,1\\n' > output/data.csv; sort output/data.csv","timeout":10}
```

Each call starts a fresh noninteractive `/bin/bash --noprofile --norc`. Cwd and shell variables do not persist. Timeout defaults to 60 seconds, with a range of 1–120.

### Access policy

- **macOS only:** `/usr/bin/sandbox-exec` applies a deny-default OS policy. Missing support or startup failure never falls back to unrestricted execution. This deprecated macOS facility may require replacement on future OS versions.
- User data is readable/writable only within the workspace; outside symlink targets are denied. Standard system executable/runtime trees are readable, including basic tools such as `cat`, `sort`, `sed` and `awk`. Root directory listing is allowed for runtime startup; this is not a chroot.
- Network access—including localhost—and general Mach/GUI service access are denied. Children inherit the sandbox.
- Environment is reset to a fixed system PATH, workspace HOME/TMPDIR, locale and TERM. Server secrets and environment variables are not inherited. Keep `config.json` outside the workspace.
- Homebrew, Xcode, Python/Node dependencies, user configuration and system temp directories outside allowed paths are not automatically available. An installed binary may still have unsupported dependencies. Use workspace HOME/TMPDIR and do not automatically broaden policy to accommodate commands.

Do not place sensitive data or hardlinks to outside sensitive files in the workspace: files already present there are in the allowed scope.

### Output, cancellation and destructive effects

Results contain combined `output`, `exit_code`, `truncated`, `timed_out` and `cancelled`. Retained output is capped at 16,000 bytes and a serialized-JSON budget; invalid UTF-8 is replaced. Redirect large output to workspace files and read it in chunks.

Nonzero exit, timeout or cancellation may leave partial changes and are tracked as [uncertain](progress.md). Exit 0 acknowledges the command, not task correctness. Tool arguments/results remain in model history; they are not copied wholesale into the progress ledger.

Stop aborts the HTTP request and kills the shell's process group. Same-group children are also stopped after completion, with a bounded wait for open output pipes. **Detached processes are not guaranteed to stop**, though they remain sandboxed. Do not launch background jobs or daemons. This is not a VM, fork-bomb defense, disk/memory quota or full resource-isolation service.

**Shell `rm`, truncation and other destructive writes can permanently destroy workspace data. Only `trash_file` moves files to Trash.** The sandbox restricts where effects occur; it does not undo them or prevent prompt injection into allowed actions.
