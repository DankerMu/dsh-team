# Office hints

This dependency-free host plugin and classic-script Web client support **DSH `0.2.1-rc.2`** through the manifest range `engines.dsh: >=0.2.1-rc.2 <0.3.0`. They show the two Office editor hints the baseline requires (F40 and the no-Session hint) around the released ONLYOFFICE editor (`dsh-sidebar-onlyoffice@0.2.0`) without a second patch to that package and without a DSH source change (D1).

| Hint                | Text                                                                   | Shown when                                                                       |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Collaboration (F40) | 请勿在 AI 修改此文件时同时编辑；人工修改保存完成后，再让 AI 继续处理。 | above the ONLYOFFICE editor of a docx, xlsx or pptx opened in a Session          |
| No Session          | 请先新建或进入一个会话（Session），再打开 Office 文件。                | instead of the editor when the tab has no Session (`sessionId` empty or missing) |

## Activation

The image delivers the plugin read-only under `/opt/dsh-team/office-hints` and the catalog lists it as a required item. The managed overlay always inserts its host row (`/opt/dsh-team/office-hints/index.js`, no config); the host half has no behaviour. The client half (`dsh.client.inject: ["dsh-better-sidebar"]`) decides by itself whether ONLYOFFICE is in effect, because the overlay cannot know an employee's own plugin switch:

- For each of docx, xlsx and pptx, while better-sidebar holds a registered and enabled `onlyoffice:<ext>` viewer, the client registers the wrapper viewer `office-hints:<ext>` (priority 20, above ONLYOFFICE's 10). When that viewer goes away or is disabled, the wrapper is disposed.
- It re-checks on better-sidebar's registry notifications (`subscribe`) and preference changes (`subscribeState`). Registration notifies synchronously, so the check is guarded against re-entry, judges "registered" from `getFileViewers()` and never throws out of a listener.
- When Office is unavailable, ONLYOFFICE is forced off or turned off by the employee, or its viewer is disabled in the side card settings, no wrapper exists. better-sidebar's conditional handoff patch (#437) then returns the file to DSH's own read-only preview.

## Wrapper viewer

The wrapper component uses no hooks and only returns elements; ONLYOFFICE is rendered as the element `h(onlyofficeViewer.component, props)` with the props passed through, so its own hooks stay in its own component. If the ONLYOFFICE viewer is missing at render time (between two notifications), the wrapper shows 「Office 编辑器未加载，请关闭后重新打开此文件。」. The hints carry `data-dsh-team-office-hint="collab"` or `"no-session"`.

Accepted residuals:

- Disabling only `office-hints:<ext>` in the side card settings opens ONLYOFFICE directly, without the collaboration hint.
- ONLYOFFICE currently reads only `scope` and `path` from its props; recheck the wrapper if it starts depending on `viewerId`.
- With `dsh-better-sidebar` turned off the client half is expected not to apply; only the default composition is covered by the Docker cases. Browser display evidence belongs to #439.
