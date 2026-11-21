# External Document Server failure

## Why

PR #641 marked F42 and task 18.6 not applicable after measuring that the bundled community `onlyoffice/documentserver:9.4.0` has no 20-connection limit. 18.6 also owned the "Office open failed" hint for a wrong external address; that half lost its owner and survives only as a residual risk in the archived tasks (`openspec/changes/archive/2026-11-20-stage-2-dsh-ragflow-office/tasks.md:4757`, `:7045-7048`). Issue #649.

Today, with an external Document Server address that is wrong or unreachable:

- the platform stores the address verbatim and never probes it (`platform/src/admin/document-server-config.ts:62-83`, `platform/src/admin/README.md:23`); `officeUnavailableReason` (`platform/src/orchestrator/document-server.ts:97-108`) returns null, so ONLYOFFICE stays enabled and the "Office 不可用时的退路" requirement (`openspec/specs/office-editing/spec.md:52-58`) does not apply;
- the released `dsh-sidebar-onlyoffice@0.2.0` loads `api.js` through the instance's same-origin `/sidebar/onlyoffice/ds/` proxy with a 20 s client timeout (`src/client/OnlyOfficeView.tsx:55-87`; proxy 502 on upstream error, `src/dsProxy.ts:357-374`) and shows its "打开失败" panel with `errApi` 「无法加载 ONLYOFFICE 编辑器脚本」 (read from the published tarball, not yet observed);
- no spec scenario, test, employee guide or deployment note covers this, and an upgrade of the plugin that turned it into a blank page or perpetual loading would go unnoticed;
- `docs/DEPLOY.md:124` and baseline D11 (`docs/REQUIREMENTS_BASELINE.md:29`) never say who owns a commercial external Document Server's licence and connection limit.

## What Changes

- **Spec (`office-editing`):** a new requirement "外部 Document Server 失效时的提示". With an external address that is unreachable, refuses, or answers without being a Document Server, the employee opening a DOCX/XLSX/PPTX sees the ONLYOFFICE open-failure panel with one of the plugin's failure texts within a bounded wait, never a blank page or endless loading; the file is unchanged; chat and file operations keep working. A licensed external Document Server's connection limit and full-capacity message belong to the Document Server itself and its operator; the project adds no hint. The existing "Office 不可用时的退路" requirement is unchanged: it promises a read-only preview with the plugin disabled, which never holds in external mode (the issue suggested adding the scenario there; a separate requirement avoids contradicting it). Wrong-JWT, incompatible-version and in-iframe errors of a reachable Document Server are explicitly not promised.
- **Employee guide:** `docs/EMPLOYEE_GUIDE.md` gains an "打开失败" section quoting the plugin's zh failure texts (`dsh-sidebar-onlyoffice@0.2.0` `src/client/locales.ts`), what they mean, and what to do: use the panel's 「下载文件」 link meanwhile; tell the administrator, who corrects the Office settings and restarts the employee's instance (settings reach an instance only at its next start); then reload the page and reopen the file.
- **Operator notes:** `docs/DEPLOY.md` external Document Server bullet and baseline D11 each state that the platform does not probe the external address, what employees see when it is wrong, that affected instances must be restarted after the address is corrected, and that a licensed external Document Server's connection limit and full-capacity behaviour are the operator's responsibility; the project adds no hint.
- **Stack scenario:** `pnpm test:stack` gains one Office scenario: through the admin API, switch to external mode with the loopback refused address `http://127.0.0.1:9` already used by the office-profile lane and a random JWT, restart the employee instance, open a DOCX, assert the plugin's `loadFailed` + `errApi` pair (not blank, not still loading), the unchanged file, a ready composer and the listed file row; in `finally`, switch back to bundled mode, restart, and prove the instance reaches the bundled Document Server again.

## Triage

```text
Issue type: documentation + test (requirement ownership gap; no fault on the bundled path)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: wrong spec/doc wording misleads operators/employees; the stack scenario mutates the shared Office configuration and must restore bundled mode or later lanes and the evidence line break
Selected risk packs: Error handling; Documentation; Concurrency / shared state / ordering (config switch + instance restart inside a shared lane)
Dependencies: PR #672 (also edits EMPLOYEE_GUIDE.md, DEPLOY.md, LOCAL_STACK.md, office-hints-stack-fixture.ts, platform-stack.stack.test.ts and an office-editing delta; adds the collab+restart hints above the panel) merges first; rebase, then measure the 800-line headroom. PR size: likely over 400 changed lines with the fixture → `diff-limit-exempt` with justification.
Evidence floor: pnpm check; openspec validate --specs --strict; local exact-head pnpm test:stack with the failure-panel evidence; exact-head VPS lane (platform/test changes are not docs-only)
```

## Capabilities

### Modified Capabilities

- `office-editing`: adds the external Document Server failure requirement.

## Impact

- `openspec/specs/office-editing/spec.md` (via delta), `docs/EMPLOYEE_GUIDE.md`, `docs/DEPLOY.md`, `docs/REQUIREMENTS_BASELINE.md` (D11), `docs/LOCAL_STACK.md` and `platform/test/README.md` stack-lane descriptions.
- `platform/test/`: a new stack fixture file plus wiring in `platform/test/platform-stack.stack.test.ts`; nothing under `platform/src/`, `plugins/` or `images/`.
- Out of scope: restoring F42 or any office-hints code; a platform-side probe or "test connection" (the platform does not probe the address, settled in the stage-2 tasks); DSH or `dsh-sidebar-onlyoffice` source (D1); `docs/DEPLOY.md` "尚未交付" wording (separate observation).
