## Why

#365. During stage-1 manual acceptance (#350) the owner said:

> 所有用户都应该登录后直接进dsh，管理员有个独有的插件或者什么的进到后台，现在是后台进到harness就退不回去了

Two problems follow from that.

- **Admin login lands on the wrong page.** Since #358, an administrator's login lands on the admin console.
- **There is no way back from DSH to the platform.** Once anyone is inside DSH:
  - administrators cannot reach the console;
  - employees cannot reach `/_platform/account` to change their password or log out.

## What Changes

- **Login landing.** Every successful login, administrator included, navigates only to `/`. The #358 administrator landing is removed: the post-login model-config read and the `/_platform/admin(/models)` targets go. Registration is unchanged.
- **`GET /_platform/api/session`.** Read-only. It returns `{ email, role }` for the current session and 401 otherwise, with a response schema, and regenerates the contract. The waiting page uses it.
- **New DSH client plugin `plugins/platform-nav/`.** It registers one entry in the installed DSH 0.2.0-rc.2 left-sidebar list slot `sidebar.footer.action`.
  - The entry shows 「账号设置」 (`/_platform/account`) to every signed-in user.
  - It shows 「管理后台」 (`/_platform/admin`) only when the instance was started for a current administrator. The managed overlay passes `{admin}` to the plugin row. The host plugin publishes it into the DSH page head through DSH's own `webserver/index-inject` global mechanism, which DSH's settings-models and shortcuts plugins also use. The client reads it synchronously and makes no network request, so lanes that open DSH directly stay free of console errors.
  - A role change takes effect at that user's next instance start. Admin pages and APIs still enforce the role on the server.
  - Both are plain same-tab links; the collapsed sidebar shows compact icons with `aria-label`s.
  - The plugin is delivered read-only in the user image at `/opt/dsh-team/platform-nav/`, through a new BuildKit named context `platform-nav=`. The managed overlay inserts and enables it.
  - No DSH source change (D1).
- **Waiting page.** In the `unconfigured` state, an administrator also sees the link 「去配置模型」 (`/_platform/admin/models`). Employees see the same text as before.
- **Docs and spec.** AGENTS.md, DEPLOY.md, the plugin/probe READMEs and the scripts are updated with the new build context and landing behaviour, along with the specs for account-auth, gateway-routing, managed-config and user-image. The `admin-console` spec has no landing or 返回工作台 scenario, so it is not modified.
- **Behaviour change.** An administrator who logs in now starts their own instance when the model is configured, so they use one running slot (`maxRunningInstances`). The PR states this under Risk.

This change also carries the archive of `model-connection-test` (#363, merged in #364), in its own commit.

## Triage

```text
Issue type: feature (reverses #358 landing)
Fixture level: expanded (public API route, auth landing, managed overlay, user image build contexts, DSH plugin surface)
Upstream suggested level: absent (agree: expanded)
Blast radius: every login; every DSH instance's overlay and boot roster; user image build inputs in tests/scripts/docs; waiting page
Selected risk packs: Public API; Config / project setup; Auth / permissions / secrets; Legacy compatibility; Release / packaging; Documentation
Evidence floor: pnpm check; pnpm test:ui (landing, waiting page, session API); plugin unit tests; exact-head VPS pnpm test:docker with real DSH sidebar evidence and exact boot roster, plus pnpm test:deploy
```
