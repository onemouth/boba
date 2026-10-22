# Progress and failure handling

Open **Progress & history** to see tool operations, results and failures. Counts describe recorded operations—not completed paragraphs, task percentages or verified success.

## States

| State | Meaning |
| --- | --- |
| `planned` | Accepted but not dispatched. |
| `running` | Dispatch is starting or in progress. |
| `succeeded` | Tool acknowledged completion; effects are not independently verified. |
| `failed` | A read-only operation failed. |
| `not_executed` | Validation, a trusted local preflight/compilation rejection, or Stop prevented execution. Run-level failure records also use this state. |
| `uncertain` | A dispatched mutation errored, timed out, was cancelled, or lost its response; partial effects may remain. Nonzero shell exits also use this state. |
| `reported` | A model checkpoint claim, not verified completion. |

Known local JavaScript compilation failures are not executed. Code that starts and throws remains uncertain. Page-origin RPC error strings cannot establish trusted execution provenance, so remote failures may remain conservatively uncertain.

## Reviewing uncertain effects

Inspect the actual page/files, wait for the operation to settle, then review the row while idle:

- **Confirm completed:** you established that the intended operation completed.
- **Confirm no effect:** you established that it had no side effects. Do not choose this for partial or unclear results.

Reviews preserve the original failure and record your assessment. They do not execute, verify or undo anything; the model cannot supply a user review.

Until review, Boba blocks exact unresolved mutation repeats and writes/edits/trash to the same unresolved path. An uncertain shell blocks tracked workspace mutations; an uncertain file mutation blocks shell calls. Reads remain available. Path aliases and changed arguments can evade some duplicate checks—these are replay guards, not a security boundary.

## Long tasks and recovery

Boba asks the model for small complete batches. A truncated completion is discarded in full: none of its calls run. Boba retries a smaller batch at most twice per instruction, within the 20-model-step limit. It never joins broken JSON/JavaScript or automatically replays previous calls.

The internal `checkpoint` tool records model-reported progress and requests another response. It does not save a file or prove completion. After a step limit or model failure, send a follow-up to continue. Important constraints may need restating when older context has been omitted.

Top-level URL changes stale the cursor and require fresh inspection. URL checks alone do not detect same-URL content replacement, iframe changes or DOM reordering; verify source identity with the [DOM tools](structured-dom.md).

## Storage and privacy

The in-memory ledger retains up to 200 records and 64 artifact paths. Pending operations and unresolved uncertainty are protected; if no record can safely be evicted, execution stops. Older terminal records can be omitted with counters retained.

The local transcript is bounded to 8 MiB; model context is further bounded to 400 messages and a byte budget. A compact progress projection accompanies model requests. This is not persistent audit storage or full conversation compaction.

Tool-argument bodies and raw file/shell output are not copied into ledger records. Instruction excerpts, paths, titles, errors and model-reported cursors may still contain sensitive information despite best-effort redaction. Normal model/tool history can contain the data supplied for the task.

**New** clears chat and progress, not page/file effects or the running page-tool instance's DOM ownership registry. Reload destroys the userscript session; Chrome target reload disconnects its controller. There is no automatic cross-reload recovery.
