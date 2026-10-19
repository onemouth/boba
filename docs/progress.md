# Runtime progress and failure ledger

Available in userscript **0.1.5+** and the regenerated Chrome DevTools runtime. This is a general agent feature; it does not modify any workspace prompt, including `bilingual.md`.

## Why

The model plans and proposes a progress cursor. The runtime records what it actually dispatched and what the tools acknowledged. These are different kinds of evidence.

The design borrows from the locally installed **Pi 1.1.0** documentation (`docs/how-pi-works.md` and `docs/compaction.md`): retain execution facts separately from the model-context projection, preserve tool-call/result pairing, and repair context after an interrupted attempt. This is a lightweight adaptation, not an implementation of Pi's session tree, synthetic failed-length tool batches, persistence, or LLM compaction.

## UI

Open **Progress & history** in the chat panel. It shows operation IDs, targets, states, failure notes, the most recent model-reported next step, and user reviews.

Counts refer to **records/tool operations**, not translated paragraphs, completed business transactions, or verified whole-task progress. A final assistant answer ends the run; it does not set an authoritative `taskCompleted` flag.

| State | Meaning |
|---|---|
| `planned` | The model supplied an accepted call, but dispatch has not begun. |
| `running` | The runtime is about to dispatch/has dispatched the tool. |
| `succeeded` | The tool returned normally without an error-shaped result. This is an acknowledgement, not independent verification of the intended effect. |
| `failed` | A read-only tool failed after dispatch; it is not assumed to have completed. |
| `not_executed` | Preflight validation/replay guard rejected the call, a trusted local DOM-tool preflight or Function construction failed, or the run stopped before dispatch. Model/run failure records also use this state to indicate no tool dispatch from that failure. |
| `uncertain` | A mutating tool was dispatched but then errored, timed out, was cancelled, or lost its connection. Partial effects may exist. |
| `reported` | A model checkpoint/cursor claim, not a verified completion. |

For example, a normal `execute_javascript` return says only that the function returned. A click acknowledgement does not prove a submission was accepted. A `write_file` response naming the requested path is recorded as a server-acknowledged artifact; it is not a read-back checksum verification.

### Reviewing uncertainty

When idle, an uncertain row offers:

- **Confirm completed**: after inspecting the real page/file, record your assessment that the intended operation completed.
- **Confirm no effect**: only when you established that it was not dispatched or had no side effects. Do not use this for partial/unclear results.

Both require confirmation. Cancellation/timeout does not guarantee that remote JavaScript or a request stopped; late effects may still arrive. Wait for the real operation to settle before making an assessment, and leave partial/unclear results uncertain. Reviews do not execute/undo anything. The original uncertain status and failure remain in the record; a separately attributed `user` review supplies its effective state. Reviews are disabled during a run and are not available as a model tool.

The runtime blocks exact repeats of unresolved mutations, plus writes/edits/trash to the same unresolved workspace path, until user review. From 0.1.7, an uncertain shell blocks all tracked workspace mutations; an uncertain file mutation blocks shell calls because shell effects cannot be assigned to one path. Nonzero shell results preserve diagnostics but are uncertain, not successful acknowledgements. Reads are still allowed for inspection. This is **best-effort local duplicate detection**, not an idempotency guarantee or a sandbox: changed JavaScript, selector aliases, path aliases, or different arguments may evade an exact-operation match. A completed operation may also be intentionally requested again by the user.

**New** clears the conversation, ledger, artifact list, and model cursor. It does not undo page changes or delete saved files. Use a new chat for an unrelated task rather than treating the old cursor as a new task plan.

## What is stored

The in-memory ledger records:

- Monotonic operation ID, model call ID, run/step, and timing.
- Tool name, a short path/selector/target summary, and dispatch/outcome state.
- Failure notes and explicit user review provenance.
- Server-acknowledged file paths.
- The model's latest checkpoint (`progress`, `next`, optional `batch_id` and `operation_ids`), explicitly marked unverified.
- A fingerprint of the top-level URL and safe display URL/title.

Full tool-argument payloads (JavaScript source, typed values and file bodies) and truncated model output are **not deliberately copied into the ledger**. Short instruction excerpts, model cursor text and errors are retained with best-effort redaction of common credential patterns. URL display drops credentials/query/fragment. This is not comprehensive secret detection: free-form instructions, titles, paths or errors can still contain sensitive data. The normal chat/tool-result transcript may contain sensitive content already permitted by the user.

No ledger is sent through the DevTools page bridge, written to workspace, uploaded to a logging service, or stored in GM/browser persistent storage. A compact ledger projection is sent to the selected model as part of task context. Page-provided metadata and model reports remain untrusted data.

## Checkpoints are claims, not completion authority

`checkpoint` still requests another small model response. It may optionally link acknowledged operation IDs from the runtime summary. Unknown/non-successful IDs are rejected. Even valid links do not prove that a semantic batch is fully correct; they only point to actions with acknowledgements or explicit user-confirmed success.

The model cannot change operation states or clear uncertainty by declaring a task complete in prose/checkpoint arguments. User reviews retain provenance and do not masquerade as tool acknowledgements.

## Recovery and model context

Every new model request includes a compact runtime projection: initial/latest instruction excerpts, source identity, aggregate outcomes, acknowledged file paths, unresolved mutations, recent failures/actions and the unverified model cursor.

- **Truncated model completion:** log `output_limit`; discard the entire incomplete response. None of its candidate tools are dispatched or logged as real operations. Keep previous outcomes and retry a smaller batch at most twice.
- **Stop/disconnect:** an in-flight mutation becomes uncertain; later undispatched calls become not executed. Synthetic error tool results repair pending tool-call/result pairing with these distinctions.
- **Source URL change:** stale the previous cursor and require `inspect_page` before further mutations. Calls selected for the old source cannot mutate a newly identified source in the same model response.
- **Tool failure:** preserve the cause and acknowledgement/uncertainty distinction; no automatic replay of a mutating call. From 0.1.6, a local typed preflight/Function-compilation rejection is known not executed; generated code that starts and throws remains uncertain. Page-origin RPC error strings do not establish trusted provenance and may remain uncertain. See [structured DOM tools](structured-dom.md).
- **Step limit/model failure:** pause with prior records intact; a follow-up can continue from that information.

Source fingerprinting currently checks the **top-level URL**, including changes to its query, without displaying the full query. It does not detect arbitrary DOM reordering, iframe chapter changes, same-URL content replacement, or establish item identity. The model must still inspect and verify stable IDs/content before continuing a batch. A stale cursor stays marked stale until the model reports a new one.

## Memory limits and scope

- Ledger: at most **200 retained records** by default. Old terminal records may be evicted, with aggregate counts and an omission count retained. Unresolved uncertainty and pending/running operations are protected. If no record can be evicted safely, the run stops rather than silently dropping uncertainty.
- Acknowledged artifact list: last **64 paths**, with an omission count; the model projection includes the latest 20.
- Model projection: recent complete user turns fitting the existing byte budget and at most 400 messages, plus compact runtime facts. Older turns can be omitted without deleting the local transcript immediately.
- Local transcript: up to **8 MiB**, evicting only complete older user turns. This is not unlimited audit history.
- A single current turn that cannot fit still stops; this is not full compaction. Short instruction excerpts cannot preserve every original constraint, so restate important requirements if needed.
- Existing 20-model-step and two truncation-retry limits remain.

Everything remains session-memory only. Full document reload/navigation destroys the userscript session. A DevTools target reload disconnects its controller; there is no automatic task recovery. No new approvals for ordinary operations, permissions, host-file endpoints, or network retry/compaction behavior are introduced.

## Tests

Node tests cover dispatch classification, partial-effect errors, skipped calls, truncation, model claims/evidence IDs, exact replay blocking, file-resource conflicts, explicit user reviews, source changes, retention/projection limits and reset semantics. A real Firefox UI regression (with mocked GM/model APIs) demonstrates a JavaScript side effect followed by an exception, manual review of the uncertain record, and clearing progress without undoing the page effect. Existing Chromium real-Go-server integration and strict-policy regressions continue to run.
