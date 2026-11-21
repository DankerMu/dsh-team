# Bundled Document Server readiness

## Why

`onlyoffice/documentserver:9.4.0` restarts `ds:docservice` and `ds:converter` once more after nginx is already serving and `/healthcheck` already answers `true`. The cause is `run-document-server.sh`: it runs `documentserver-generate-allfonts.sh` (`:837-839`), which ends with `supervisorctl restart`, and only then starts its final step `find … | xargs tail -F` (`:841-845`). The window is about 70–135 s after every container start; a full stack run measured `startupMs: 135241`, `spawns: 2`.

During that window the platform keeps starting employee instances and handing them Office. An editor opened in the window can lose its session: write-back `unchanged`, or a collaboration WebSocket 502. Nothing marks the window:

- `deploy/compose.yml` has no healthcheck on `documentserver`;
- employees get no hint;
- `docs/DEPLOY.md` does not mention the window.

Only the stack test lane waits for it (`platform/test/office-hints-stack-fixture.ts:204-229`). Issue #648.

Owner decisions (issue comments, 2026-11-21):

- Chosen direction: compose healthcheck keyed on "startup script finished", an employee hint, and an operator note.
- Rejected: blocking at instance start (critical path; the overlay is written once per start) and documentation-only.
- The hint is a **static note**. The browser cannot read the startup state: the same-origin DS `/healthcheck` is already `true` inside the window, and the editor's connection state is internal to `dsh-sidebar-onlyoffice`.

## What Changes

- **Compose healthcheck:** `deploy/compose.yml` `documentserver` gains a healthcheck that is healthy only once the startup script's final step (`xargs tail -F`) is running, with a start period that covers the measured window. Nothing waits on it (no `depends_on` change; the platform's instance start is unchanged). It is the operator's readiness signal and Compose's status.
- **Deploy stand-in:** `pnpm test:deploy`'s Document Server stand-in reaches healthy through the same healthcheck definition, by running a process of the same final-step shape. The healthcheck is neither overridden nor disabled.
- **Static editor note:** `plugins/office-hints` adds a fixed note next to the F40 collaboration hint: 「Office 服务刚启动或重启后约 2 分钟内，编辑器可能断开；如果断开，请稍后重新打开此文件，未保存的修改可能丢失。」 It is marked `data-dsh-team-office-hint="restart"`. The F40 text and the no-Session hint are unchanged.
- **Operator note:** `docs/DEPLOY.md` §「自带 Document Server（Office）」 states the window's cause, the operations that trigger it (first `up -d`, every platform image update, `docker restart dsh-team-documentserver` after a firewall-holder restart, host reboot), and how to wait for `healthy`.
- **Stack evidence:** the stack lane keeps its own `pgrep` probe as an independent oracle and additionally proves the health timeline: never `healthy` before the final step is observed, `healthy` afterwards, and `docserviceSpawns` unchanged after `healthy`.

## Triage

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: production compose config, shared deploy/stack fixtures and a shipped plugin UI; owner-chosen direction)
Blast radius: a wrong healthcheck either reports healthy inside the window (operators reopen Office too early) or never healthy (the stand-in and real DS look broken, operators wait forever); a changed F40 text breaks the office-editing spec and three tests
Selected risk packs: Config / project setup; Legacy compatibility; Error handling; Concurrency / shared state / ordering; Documentation; Release / packaging (plugin ships in the user image)
Evidence floor: office-hints unit tests; deployment compose fixture integration tests; pnpm check; local exact-head pnpm test:stack with the health timeline; exact-head VPS pnpm test:docker + pnpm test:deploy (stand-in healthy through the same definition)
```
