# Profile seed reset notes

## Why

Issue #682. Line numbers are on main `e33308f`.

Every catalog entry in the user image is copied from `plugins/<id>/` into its canonical `/opt/dsh-team/<id>` copy (`images/dsh-user/Dockerfile:80-104`), build-time patches are written into the canonical copy (`Dockerfile:65-75`, `patch-package.mjs`), and each entry is then registered as an installed profile dependency with a uid1001 copy (`Dockerfile:144-147`, `catalog-check.mjs:510-529`, recursive). The profile tree becomes `/opt/dsh-team/profile-seed`. Docker copy-up seeds only an empty home volume (`Dockerfile:140`), and an existing volume's `profiles/` is rewritten only by the administrator's 「重置配置」 (`platform/src/orchestrator/profile-restore.ts:21-37`).

What an image update reaches without a reset depends on how each plugin is loaded:

- **Next instance start, for everyone** (the overlay is generated at start, B20):
  - `permission-tiers`, `platform-nav`, `office-hints`: inserted by absolute image path (`platform/src/managed-config/generate.ts:405-416`).
  - `knowledge-base`: its only row inserts `/opt/dsh-team/knowledge-base/index.js` (`plugins/knowledge-base/cordis.patch.yml`, `Dockerfile:97`); the client half is delivered by the adjacent manifest (`plugins/knowledge-base/README.md:81`).
  - The `zh-locale` patch row, read from `/opt/dsh-team/profile-seed` (`platform/src/managed-config/read.ts:14-15,57`), and the overlay's `dsh-sidebar-onlyoffice` / `knowledge-base` config rows (`generate.ts:293-311`).
- **Only through the employee's profile copy** (stays old until reset):
  - `dsh-better-sidebar` and `dsh-sidebar-onlyoffice`, including their build-time patches: resolved by package name; the image has no global copy and the profile copy's hashes are asserted (`platform/test/user-image.docker.test.ts:112,505`, `:502,566`).
  - `office-agents`: presets come from the profile composition (`read.ts:47-54`, `generate.ts:381-383`), and `docx-construction` and `skills` resolve from the profile copy. The image's `/opt` patch is written whole only for a forced-on bundle missing from the volume (`generate.ts:152-169`).
  - `zh-locale`'s code (`index.js`, `client.js`): inserted by package name, so it resolves from the profile `node_modules`. Inferred from DSH's profile resolution, not observed on an old volume.

Nothing compares plugin versions: the only loud signals are a bundle DSH skips (`read.ts:43`, `profile-incompatible`, `docs/DEPLOY.md:59`) and a forced bundle's changed row id (`DEPLOY.md:65`). So an image update that changes any file of the second group — a patch, a repository plugin's delivered file, with or without a version change — leaves existing employees on the old copy with no error, notice or audit row. This is a settled stage-2 decision (no automatic sync; T5 / task package 3.4), but the documents do not say it:

- `docs/DEPLOY.md:59` and `:65` cover only the loud cases.
- `docs/EMPLOYEE_GUIDE.md` describes patched behaviour — Office files opening in ONLYOFFICE (`:7`, #437) and the editor refresh after an AI rewrite (`:59`, #652) — without the prerequisite.
- `.github/PULL_REQUEST_TEMPLATE.md` has no prompt for the operational step.

「重置配置」 is not free (`DEPLOY.md:301-303`, `profile-restore.ts:34-35`): it disconnects the employee and stops the instance, deletes the whole `profiles/` tree — employee-installed bundles (installed into the profile, `DEPLOY.md:57`) and plugin switches return to the image defaults — and leaves the instance stopped. `sessions/`, `storages/`, `attachments/`, `.credentials.yaml`, `/data/home/cordis.patch.yml` and the work volume are kept.

## What Changes

Documentation only (the issue's recommended option):

- **`docs/DEPLOY.md` upgrade notes:** after `:59`, a paragraph:
  - an image update that changes any file of a profile-loaded plugin (build-time patch or a preinstalled `plugins/<id>/` file, version changed or not) gives existing employees no error, prompt or audit row; they keep the old copy until the administrator runs 「重置配置」 for each of them;
  - the two groups above, by plugin, with `zh-locale`'s code marked as inferred;
  - the reset's cost: the instance is stopped, employee-installed bundles are removed and plugin switches return to the defaults, files, conversations and credentials are kept, and the instance must be started again (referring to § 8);
  - automatic sync is not part of stage 2.
- **`docs/EMPLOYEE_GUIDE.md`:** one note before the two Office sections (`:5`, `:59`): opening Office files in ONLYOFFICE, the editor itself and the refresh after an AI rewrite assume a new account or that the administrator has reset this employee's configuration after the image update; if what you see differs, ask the administrator. The notices from `office-hints` are not affected, and the note must not imply they are.
- **`.github/PULL_REQUEST_TEMPLATE.md` Risk:** one checkbox: changes a build-time patch under `images/dsh-user/` or a delivered file of a preinstalled `plugins/<id>/` that loads from the profile — existing employees need 「重置配置」 (`docs/DEPLOY.md` upgrade notes); say so in the PR. No gate parses the template.
- **Excluded:** alternatives 1 (startup drift detection, orchestrator critical path) and 2 (moving T5 forward) need triage and a user decision; not done.

## Triage

```text
Issue type: docs (operational prerequisite)
Fixture level: light
Upstream suggested level: absent
Blast radius: deployment and employee docs, PR template; no code
Selected risk packs: Documentation / migration notes
Evidence floor: docs/ is prettier-ignored and outside lint:agents, so the docs are review-only: every claim checked against the cited code lines; pnpm fmt:check covers the template and fixture only; CI
```

## Acceptance-criteria mapping (#682)

- **AC1** (DEPLOY.md upgrade notes: no error, reset each existing employee, the profile-loaded plugins listed) → 1.1.
- **AC2** (EMPLOYEE_GUIDE Office sections note the reset prerequisite) → 1.2.
- **AC3** (alternative 1 Docker case) → not applicable; alternative 1 not chosen.
- **In scope 3** (prompt the operational step in patch-changing PRs) → 1.3. PR #680 is already merged (`24ad366`); its step is covered by the DEPLOY.md paragraph.

## Must preserve

- The existing `DEPLOY.md:59`, `:65` and § 8 content; the guide's existing Office wording.
- The documents' language (Chinese for docs/, English for the PR template).
