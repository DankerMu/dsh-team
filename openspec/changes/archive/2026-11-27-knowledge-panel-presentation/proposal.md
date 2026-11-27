## Why

#761: in the stage-2 manual acceptance the project owner found the 「知识库」 panel unpolished. The panel already works (F27), but it reads as unstyled HTML:

- a full-width filter field and 「筛选」 button under every library;
- browser-default bullet lists;
- a 「上一页 / 第 1 / 1 页 / 下一页」 row even when there is one page;
- library titles as bare bold text with no expand affordance and no separation.

## What Changes

Presentation only, in `plugins/knowledge-base/client.js`. Requests, routes, state names, texts and data attributes stay as they are. The panel gets its own new style constants. The helpers shared with the composer scope control (`CONTROL`, `button()`, `notice()`, `datasetsView`, `LIST_TEXT`) keep their current output; `notice()` stays for the scope control and the panel's states use a new panel notice constant.

- **Library rows.** Each library is one row (`li[data-dsh-team-kb-dataset]`) with a thin divider on DSH's border variable and a hover background.
  - A chevron marks the expand state: an `aria-hidden` SVG without text, placed in the row **outside** the title button, rotated when expanded.
  - The title button still has exactly the library name as text and accessible name.
  - Libraries are collapsed by default, as today.
- **Expanded library.**
  - A count line 「共 N 个文件」 sits above the file rows, outside every file row and outside the title button.
  - Below it is a compact filter group: the `<form>` still holds the `input[aria-label="按文件名筛选"]` and a `type="submit"` 「筛选」 button, joined in one bordered group.
- **File rows.** `li[data-dsh-team-kb-file]` has no bullet. A small document glyph is an `aria-hidden` SVG without text, so the row's textContent stays exactly the file name. Long names truncate with an ellipsis, and the full name goes in `title`.
- **Paging.** It is shown only when there is more than one page.
- **States.** The panel's five non-list states (loading, empty, no-match, failed, not-configured) keep their texts and get one shared notice look: a secondary-colour line with spacing, and failed with its 「重试」 button beside the text. Together with `list` these are the six displays `client.test.js` already distinguishes.
- **Theme.** All colours, radii and spacing come from DSH's `--dsw-*` CSS variables with the current fallbacks, so light and dark both work. No new dependency and no stylesheet file.

### Divergences from issue #761

1. **File count only when expanded.** The issue asks for it in the collapsed title row. That would need one documents request per library on list load, up to 1000. The count appears once the library is expanded, taken from the answer the panel already fetches; no extra requests.
2. **Two single-page assertions change.** The issue says the existing plugin tests pass unchanged. Two assertions (`client.test.js:496` and `:663`) expect 「第 1 / 1 页」 on a one-page result, and this change removes single-page paging by design. They are replaced, not weakened: no paging row, and 「共 1 个文件」 shown. The multi-page paging tests stay as they are.
3. **One document glyph, not per-type icons.** The issue suggests file-type icons. The seed libraries and the proxy answer carry only names, so a per-extension icon table would be guesswork about RAGFlow's file mix. One neutral document glyph is used; per-type icons are a non-goal.

## Impact

- `plugins/knowledge-base/client.js`, `client.test.js`, `README.md` (§ Panel).
- `platform/test/knowledge-panel-stack-fixture.ts` keeps working unchanged under the structural contract in tasks.md. Touch it only if a locator breaks, and report that as a deviation.

## Triage

```text
Issue type: feature (presentation)
Fixture level: compact
Upstream suggested level: absent (override of the legacy-compatibility expanded trigger: helpers shared with the scope control keep their output and the panel uses new constants; the stack lane's structural contract is pinned in tasks.md)
Blast radius: the panel's look; a broken locator or state would fail the stack lane's knowledge steps
Selected risk packs: Legacy compatibility; Documentation
Evidence floor: plugin unit tests (client.test.js, coverage 80%), pnpm test:integration, pnpm test:stack panel steps, light/dark screenshots
```

`design.md` is omitted at `compact`.
