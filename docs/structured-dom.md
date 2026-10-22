# Structured DOM tools

These tools read and modify text using predefined DOM APIs—no eval, arbitrary HTML, Trusted Types policy or relaxed CSP. Use them for text tasks when generated JavaScript is blocked. Browser-protected pages, cross-origin frames and site layout restrictions still apply.

## Typical workflow

1. `read_text`: read a small batch and retain the returned source IDs.
2. `insert_text`: add plain-text translations paired with those IDs.
3. `set_style`: adjust permitted inline styles.
4. `verify_dom`: inspect source integrity, pairing and layout hints.
5. `remove_inserted`: clean up owned insertions and tracked styles when needed.

Source IDs represent actual elements and original text snapshots, not guessed positions. Changed text, replaced/detached elements or frame navigation invalidates a snapshot. Reread before proceeding.

## `read_text`

```json
{"selector":"article","frame":"#reader","limit":5,"max_chars":4000}
```

Only `selector` is required. `frame` selects a unique accessible same-origin iframe.

| Argument | Default / behavior |
| --- | --- |
| `mode` | `paragraphs`: a single container expands to descendant `<p>` blocks when present. `element` reads matched elements themselves. |
| `include_hidden` | `false`; true includes hidden text. Scripts, form fields, editable controls and this session's owned insertions remain excluded. |
| `offset` | Starting block index, default 0. |
| `limit` | Up to 20 blocks; default 5. |
| `char_offset` | Offset into the first selected block; default 0. |
| `max_chars` | Text budget, default 4000, maximum 8000; serialized-output limits may shorten it further. |

Items contain `source_id`, `index`, `text`, `char_offset`, `total_chars`, `complete` and `last_chunk`. Follow the response's `next_offset`, `next_char_offset` and `more` until all required text is collected. `complete` means an item contains the entire source; `last_chunk` means it reaches the source's end. A final chunk can be incomplete on its own. Collect all chunks before translating a paragraph.

Offsets use JavaScript UTF-16 units. Text preserves newlines and adds breaks for `<br>`/semantic blocks, but is not a pixel-perfect reconstruction of rendered `innerText`: CSS-only hidden descendants and unusual layout can differ.

## `insert_text`

```json
{"items":[{"source_id":"RETURNED_SOURCE_ID","text":"第一行\n第二行","lang":"zh-Hant-TW"}]}
```

- `items`: 1–10 source/text objects, with optional BCP-47 `lang`. Total inserted text is limited to 8000 characters; skip empty original paragraphs instead of inserting blank translations.
- `key`: ownership slot per source, default `translation`; up to 40 alphanumeric/dash/underscore characters.
- `position`: `append` (default), `prepend`, `before` or `after`. Invalid table/list insertion positions are rejected; select a paragraph, cell or list item.

Insertions are block-displayed spans with preserved whitespace, assigned through `textContent`. Markup-looking text stays literal; original nodes, links and event handlers are not replaced. Repeating source ID + key updates the same node.

The batch is prevalidated, with checks repeated between items. Stale sources, external text edits, movement and conflicting ownership are rejected. A mid-application error can still leave earlier items applied; there is no transactional rollback.

Clean up an older insertion before inserting against a changed source's new snapshot. For long translations, use small explicitly tracked numbered keys/chunks and verify each. No automatic semantic splitter or rich-HTML renderer is provided.

## `set_style`

```json
{"source_ids":["RETURNED_SOURCE_ID"],"properties":{"color":"#8b3f52","line-height":"1.8"}}
```

`source_ids` and `properties` are required. `target` defaults to `inserted`; `source` styles the original element. `key` selects the insertion slot. To style a specific container, read it with `mode:element` first.

Allowed properties: `color`, `background-color`, `font-size`, `font-weight`, `font-style`, `line-height`, `text-align`, `white-space`, `overflow-wrap`, `display`, `visibility`, `width`, `max-width`, and each side of `margin-*`/`padding-*`.

Calls accept 1–16 simple values. URLs, expressions, variables/attributes and stylesheet syntax are rejected. Values are parsed and assigned inline with important priority. Prior values/priorities are retained for cleanup; external changes to tracked properties cause refusal. Assignment alone does not prove readability.

## `remove_inserted`

Optional `source_ids` and `key` select retained owned content; `{}` selects all. `restore_styles` defaults to true.

Ownership uses private node references, not just classes/attributes. Page-created lookalikes are not deleted. Externally edited text, nodes adopted into another document and conflicting styles are preserved and reported as `skipped`. Only inline properties still matching Boba's last assigned value are restored; unrelated changes remain untouched.

`partial:true` means cleanup was incomplete. At most 20 skipped details are returned, with `skipped_count` and `skipped_truncated` preserving the count. `restore_styles:false` leaves source styling available for later restoration while retained. Cleanup does not undo arbitrary JavaScript or other website changes.

## `verify_dom`

Provide up to 10 `source_ids`, with optional `key` (default `translation`). Results include source integrity, owned pairing/marker counts, text integrity, language/character counts, style conflicts, visibility, rectangles and overflow hints.

Empty sources without insertions are valid section breaks. **`all_paired` is not verification of translation accuracy, visibility, all-key completeness, reader navigation or screenshots.** Inspect the other fields; unavailable geometry is not visual evidence. Complex EPUB pagination can require separate repair that these tools do not provide.

## Limits and lifetime

Each running page-tool instance retains up to 500 source snapshots (2,000,000 total UTF-16 units; 200,000 per block) and 500 inserted nodes. Unowned/unstyled snapshots may be evicted; expired IDs require rereading. Protected snapshots are not silently evicted.

**New** clears chat/progress but preserves the running instance's ownership references and DOM effects. Reload clears all references. Closing a Chrome controller tears down its page bridge; a new instance cannot adopt the old instance's insertions. Clean up first or reload the page. There is no persistent ownership or cross-reload recovery.
