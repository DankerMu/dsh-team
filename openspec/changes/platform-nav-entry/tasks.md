## Risk packs

- **Public API — selected.** The new `GET /_platform/api/session` route, its schema and the regenerated contract. Tasks 1.1 and 3.2.
- **Config / project setup — selected.** The managed overlay row and the new user-image build context (`platform-nav=`) in every build invocation. Tasks 2.2 and 2.3.
- **Auth / permissions / secrets — selected.** The landing change, a session endpoint that exposes only `{email, role}`, and a role-gated link whose flag comes from the overlay at instance start and whose authority stays on the server. Tasks 1.1, 1.2, 2.1 and 2.3.
- **Legacy compatibility / examples — selected.** The #358 landing is reversed, while employee and registration behaviour, the waiting-page states and the existing DSH lanes stay unchanged. Tasks 1.2, 1.3 and 3.1–3.3.
- **Release / packaging / dependency compatibility — selected.** The user image gains a plugin pinned to the DSH peer version; the boot roster changes. Tasks 2.2 and 3.3.
- **Documentation / migration notes — selected.** AGENTS.md, DEPLOY.md, the READMEs and the scripts. Task 2.5.
- **Not selected:**
  - File IO: only image COPY, covered by Release.
  - Schema/DB: no persisted change.
  - Concurrency: no shared state.
  - Resource limits: no unbounded input.
  - Error handling: the plugin and waiting-page failure paths are covered by tasks 1.3 and 2.1.

## Must preserve

See `design.md`, "Must preserve".

## 1. Platform

- [x] 1.1 Add `GET /_platform/api/session`. It returns `{email, role}` or a sanitized 401, uses the existing session lookup semantics, and has a schema; then run `pnpm contract:write`. Add unit and integration tests.
- [x] 1.2 Login landing goes to `/` for every role. Remove the #358 administrator landing and any browser predicate left unused. Update the account-page unit tests and UI tests: list each #358 assertion that changes because its behaviour is reversed.
- [x] 1.3 Waiting page: in the `unconfigured` state, call the session endpoint once and show the admin-only link 「去配置模型」 to `/_platform/admin/models`. Add unit and UI tests for both roles and for failure.

## 2. DSH plugin and image

- [x] 2.1 Create `plugins/platform-nav/`:
  - `package.json` (`dsh.client`, exports, inject, peer pin), `index.js`, `client.js`, `client.test.js`, types and a README;
  - a host `index.js`/`index.test.js` that publishes the `__DSH_TEAM_PLATFORM_NAV__` global from its row config;
  - a client entry in `sidebar.footer.action` that reads the global synchronously, makes no network request, and renders role-gated links in wide and narrow modes;
  - no console calls or exceptions;
  - registration in `vitest.config.ts` coverage, `knip.json`, the `package.json` typecheck script and its own `tsconfig.json`.
- [x] 2.2 `images/dsh-user/Dockerfile`: deliver it root-owned and read-only to `/opt/dsh-team/platform-nav/` with the peer-pin check. Add the `platform-nav=` named context to every build invocation (`git grep "permission-tiers="`).
- [x] 2.3 Managed overlay: add the insert row for `/opt/dsh-team/platform-nav/index.js` with `config: { admin }`, add `ManagedConfigInput.admin`, and have the start path pass the current account role (a minimal orchestrator diff, critical path). Add `generate` unit tests. Add `@dsh-team/platform-nav` to `MANAGED_BOOT_ROSTER`.
- [x] 2.4 Docker evidence:
  - extend `scripts/probe-mapped-host.mjs` `acceptObservation` for the sidebar links, a click and collapsed mode;
  - an employee case in `first-use.docker.test.ts` and an admin case in `admin-config-activation.docker.test.ts`;
  - root-owned read-only artifact metadata and the peer pin in the user-image Docker test.
- [x] 2.5 Docs: the AGENTS.md landing paragraph (replacing the #358 text) and the build-context lists, DEPLOY.md build examples and the post-login note, the plugin READMEs and the probe scripts.

## 3. Verification

- [x] 3.1 `pnpm check`
- [x] 3.2 `pnpm test:ui` and `pnpm contract:check`
- [ ] 3.3 Exact-head VPS `pnpm test:docker` with the real DSH sidebar case, the exact roster and the image artifact metadata, plus `pnpm test:deploy`; CI green.

## Non-goals

See `design.md`, "Non-goals".
