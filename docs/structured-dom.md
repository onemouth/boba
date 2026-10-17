# Structured DOM tools (userscript 0.1.6+)

These tools use prewritten DOM APIs. They do **not** compile model text with `eval`/`Function`, parse arbitrary HTML, create a Trusted Types policy, or weaken a website's CSP. They are available in the userscript and regenerated DevTools page bridge.

This can enable text extraction and bilingual insertion when `execute_javascript` is CSP-blocked. It does not bypass cross-origin frames, protected pages, unavailable userscript injection, restrictive layout, or other browser policies. No screenshots or browser-extension permissions are added.

## Example

1. Read a small complete batch:

```json
{"selector":"article","frame":"#reader","limit":5,"max_chars":4000}
```

`read_text` returns records such as:

```json
{
  "source_id":"boba-example-s1",
  "index":0,
  "text":"First line\nSecond line",
  "char_offset":0,
  "total_chars":22,
  "complete":true,
  "last_chunk":true
}
```

2. Translate, then call `insert_text` with the actual returned ID:

```json
{"items":[{"source_id":"boba-example-s1","text":"第一行\n第二行","lang":"zh-Hant-TW"}]}
```

3. Style that owned insertion:

```json
{"source_ids":["boba-example-s1"],"properties":{"color":"#8b3f52","line-height":"1.8"}}
```

4. Call `verify_dom`:

```json
{"source_ids":["boba-example-s1"]}
```

5. To clean up, call `remove_inserted` with those IDs, or `{}` to clean up all content owned by this running page-tool session.

The agent's general instructions prefer this route for text tasks, including when an older workspace prompt describes equivalent JavaScript extraction/injection. No workspace prompt is changed by this implementation.

## `read_text`

- Required `selector`: a container or non-overlapping text elements.
- Optional `frame`: a **unique selector** of an accessible same-origin iframe. Results retain the actual frame/document identity, not merely the selector.
- `mode`: default `paragraphs`. A single container expands to descendant `<p>` blocks if present; otherwise matched elements are read directly. `element` reads the selected elements themselves, useful for styling a specific container.
- `include_hidden`: default false. Hidden blocks and explicitly hidden descendants are skipped; true includes hidden text. Scripts, forms/fields, active editable controls, and this session's owned inserted nodes remain excluded.
- `offset`: starting block index, default 0.
- `limit`: default 5, maximum 20 blocks.
- `char_offset`: offset into the **first** selected block only.
- `max_chars`: default 4000, maximum 8000 text characters per result. A second serialized-output budget may shorten the batch further so JSON escaping does not turn it into a misleading generic preview.

Text preserves DOM text newlines and adds breaks for `<br>`/semantic block boundaries. It is **not a pixel-perfect reconstruction of `innerText`**: CSS-only hidden descendants and unusual layout can differ from what is visually rendered. HTML structure/formatting, scripts and form values are not exported as text.

Always follow `next_offset`, `next_char_offset` and `more`. `complete` means this one item contains its entire source; `last_chunk` means the end of that source has been reached. A long paragraph's final chunk can have `last_chunk:true` and `complete:false`. Collect all chunks before translating the paragraph. Offsets are JavaScript UTF-16 string offsets, not grapheme counts. No missing text is silently treated as a full paragraph.

Source IDs refer to actual elements plus full original text snapshots, not numeric positions. Reordering elements does not mispair them. Changed text, replaced/detached elements, document navigation or frame replacement invalidates the snapshot. Read again rather than guessing an ID.

## `insert_text`

- Required `items`: 1–10 objects containing `source_id`, complete plain `text`, and optional BCP-47 `lang`.
- Batch inserted text is limited to **8000 characters**. Empty/whitespace-only insertions are rejected; skip empty original paragraphs.
- `key`: default `translation`; alphanumeric/dash/underscore, up to 40 characters. It identifies an ownership slot per source.
- `position`: `append` (default), `prepend`, `before`, or `after`. Insertion into restricted table/list containers, or invalid sibling positions, is rejected; choose a paragraph, cell or list item.

Each insertion is a `<span class="boba-inserted-text">` with a block display and preserved whitespace. Chinese-language insertions also receive `boba-zh-translation`. Text is assigned with `textContent`, never `innerHTML`; markup-looking text stays literal. Original nodes, links, events and form state are not replaced.

A repeat of **source ID + key** updates the same node. The whole batch is prevalidated before mutation. Source changes, mismatched ownership, external text edits/movement or duplicated markers are rejected. Application checks are repeated between items; a failure after earlier items applied is an uncertain partial operation, not a transaction rollback.

When a changed source is reread, its older insertion must be cleaned up before inserting against the new snapshot. For unusually long translations, use small explicitly tracked numbered keys/chunks and verify each; do not emit a giant tool call. There is no automatic semantic splitter or HTML-rich translation renderer.

## `set_style`

Required `source_ids` and `properties`. `target` defaults to `inserted`; use `source` to style a selected original element. `key` selects the insertion slot.

Allowed kebab-case properties:

- `color`, `background-color`
- `font-size`, `font-weight`, `font-style`, `line-height`
- `text-align`, `white-space`, `overflow-wrap`
- `display`, `visibility`, `width`, `max-width`
- `margin-top/right/bottom/left`, `padding-top/right/bottom/left`

Between 1 and 16 simple values are accepted per call. Values are checked by a detached CSS declaration parser and reject URLs, expressions, variables/attributes, arbitrary stylesheet syntax, event/script fields and non-allowlisted properties. No stylesheet text, `background-image`, positioning, selectors or raw HTML is accepted. Values are assigned with important priority.

Original inline values/priorities are retained per property for cleanup. External changes to a tracked property cause refusal instead of silently overwriting it. CSS assignment is not proof of visible/readable output; inspect verification/layout results. For example, use `read_text` with `mode:element` to obtain the exact sidebar's ID before setting its source display to none.

## `remove_inserted`

Optional `source_ids`/`key` select owned content; omitted means all retained owned content. `restore_styles` defaults to true.

Ownership is based on private node references, **not just CSS classes or page-visible attributes**. Page-created lookalikes/clones are not adopted or deleted. Externally edited owned text, nodes adopted into another document, and conflicting style changes are preserved and reported under `skipped`. `partial:true` means cleanup was incomplete; do not claim full restoration. At most 20 skipped details are returned, with `skipped_count` and `skipped_truncated` preserving the full count.

Only tracked inline properties still matching Boba's last assigned value are restored. Unrelated styles and external later edits are left alone. With `restore_styles:false`, source style changes are left in place and can be restored later while retained. Cleanup does not undo arbitrary JavaScript or all website changes.

## `verify_dom`

Required `source_ids` (at most 10 per verification call); optional `key`, default translation. Returns:

- Source snapshot unchanged/stale state.
- Owned pairing, ownership-marker count and text integrity.
- Language and source/inserted character counts.
- Source/insertion visibility hints, node rectangles, available layout and horizontal-overflow hints.
- Conflicts with tracked inline properties.

Empty sources without insertions are valid empty section breaks. `all_paired` checks DOM pairing/source integrity, **not visibility, translation accuracy, all-key completeness, first/last reader page reachability or screenshot correctness**. Inspect the visibility/layout/conflict fields too. `null` overflow/layout information is not evidence of a successful visual check.

Pagination repair in complex EPUB readers remains separate work: adding text changes column/page counts, and these five tools do not provide arbitrary reader transforms, browser shortcuts or automatic screenshots.

## Execution states and lifecycle

A local `ToolDispatchError` is raised only for known preflight/compilation rejection before generated code is invoked or structured mutations begin. The userscript ledger marks it `not_executed`. A generated function that starts and throws remains `uncertain` for mutations, even if its error spoofs status fields.

The DevTools bridge deliberately does not trust page-origin error fields as authoritative execution proof; errors losing local typed provenance can remain conservatively uncertain. Do not retry eval simply to escape CSP; use the structured tools.

Registries are in memory per running page-tool instance. Up to 500 source snapshots (2,000,000 total stored UTF-16 units; 200,000 per block) and 500 owned inserted nodes are retained. Unowned/unstyled snapshots may be evicted; expired IDs require rereading. Protected snapshots are not silently evicted. Limits require smaller scopes, cleanup or reload.

**New chat** clears the agent ledger, not these DOM ownership references or page effects. The same running instance can reread or clean up its content. Closing a DevTools controller tears down that page bridge; a new instance cannot safely adopt the previous instance's DOM nodes. Clean up first or reload to restore the underlying page. Full reload clears all registries; there is no persistent ownership or cross-reload recovery.

Tests use real Firefox strict CSP/Trusted Types with a same-origin reader iframe, plus the real Chromium/Go DevTools transport. Model responses are mocked; no paid model calls or live reader-site compatibility guarantees are implied.
