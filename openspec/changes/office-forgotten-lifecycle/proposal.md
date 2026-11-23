# Office forgotten copy lifecycle

## Why

Issue #650. Line numbers are on main `823bc1b`.

When a Document Server session closes with a save the plugin refuses (HTTP 200 `{error:1}` from the size/mtime guard), Document Server 9.4.0 stores the assembled document as a forgotten copy, `forgotten/<key>/output.<ext>` (ONLYOFFICE server `canvasservice.js:1302-1332`). Source reading (issue § 证据) shows the copy is removed only by a later successful save under the same key or by Command Service `deleteForgotten`; there is no expiry and no setting for one. The document key derives from the file's size and mtime, so after an AI rewrite the old key is never issued again.

Three stack cases close a session whose save is refused:

- the rewrite `unsaved` case (#442; `EXPECTED_REWRITE.unsaved` expects the refusal);
- the typing case (#652; `EXPECTED_TYPING`, `office-rewrite-stack-fixture.ts:97-110`: the refreshed-away session's status 2 is refused, `'save-error': 1`);
- the forgotten case (#624; deliberately, `office-forgotten-stack-fixture.ts:467-517`); PR #634 also suspected its recover session leaves another copy at close.

None observes the store afterwards except the forgotten case's positive control, and none cleans up. So the guide's 「已经丢失」 (`docs/EMPLOYEE_GUIDE.md:71`) is unverified and likely wrong from the server's side, and `docs/DEPLOY.md` § 7 (`:284`) and § 8 (`:304-`) say nothing about where copies live, that they never expire, or how to remove them.

The store sits under `/var/lib/onlyoffice`, one of three paths the `onlyoffice/documentserver:9.4.0` image declares as `VOLUME` (with `/var/log/onlyoffice` and `/var/www/onlyoffice/Data`; `/usr/share/fonts/truetype/custom` is bind-mounted by Compose). `deploy/compose.yml:77-` names none of them, so they are Compose anonymous volumes. Per Compose semantics (review-only, no lane verifies it): `up -d` recreating the container reattaches them (unless `-V`); `down` leaves them on disk but the next `up` creates fresh ones, so the old copies become unreachable orphans that § 8's prefix check (`:320`) cannot see.

## What Changes

The issue's recommended direction: measure, document, clean up. No production code, no critical path.

### One forgotten-store module

The global-count wording in this section (`forgottenDirs`, its baseline and the `cache/files` parent check) is superseded by § Key-scoped counting (measured) below.

New `platform/test/document-server-forgotten-fixture.ts`. The rewrite fixture must use the store helpers, and the forgotten fixture already imports the rewrite fixture (`NOTICES`), so the helpers move out of the forgotten fixture, unchanged where possible, with every importer updated and no re-export:

- moved: `FORGOTTEN_DIR`, `forgottenDirs`, `namespaceForgottenListScript`, `forgottenPresent`, the guarded `forgottenList` call, and `registeredKey` generalised to `registeredKey(lane, path)` (it polls the plugin registry, which is written with a 500 ms debounce; a single `registryKeys` read would race);
- its own minimal lane types (`Pick<…, 'run' | 'exec'>`, `{ namespaceRead: NamespaceRead }`), never the forgotten fixture's private `OfficeForgottenLane` (dependency-cruiser counts type-only imports);
- `forgottenDirs` fails loudly: a missing `cache/files` parent, a failed `find` or a count that is not a non-negative integer throws (today an unreadable store returns `NaN`, which `Object.is` treats as equal to itself). A missing `forgotten/` itself counts `0`: a freshly started 9.4.0 creates only `cache/files` (`run-document-server.sh:696`, observed in a throwaway container) and `forgotten/` appears with the first copy; a wrong last path segment is caught by the anchor below;
- new `removeForgotten(lane, key, label)`: inside the Document Server container, removes the `FORGOTTEN_DIR` entries whose name's SHA-256 (`printf %s "$name" | sha256sum`) equals the key's digest; only the digest is in the script, stderr is discarded, and the call is wrapped in `guarded(label, [key], …)` so no failure output carries the key (the directory name is the key). Returns the number removed;
- new observation `forgottenCopy(lane, key, baseline)` → `{ added, listed }`: the `forgottenDirs` delta and whether the namespace list holds the key (`listed || contains`); a list read that is not `status 200, error 0` throws, so a failed read never counts as "not listed";
- a settle wait before observing: the refused close-time callback runs seconds after the session closes, so observation and cleanup run after a 15 s window (today's `OBSERVE_MS`), on success and failure paths alike. The constant and the wait live in the new module (the rewrite fixture imports it, never the reverse); the window is an injectable parameter so stand-ins do not sleep 15 s.

### Key-scoped counting (measured)

The first exact-head stack run (`4a63aa5`) showed that the store's total directory count is not a usable baseline: earlier Office lanes' sessions close asynchronously and their refused callbacks land copies (an `output.docx` before the forgotten case, an `output.pptx` during its trigger) while later cases run. The same run proved the layout: after the trigger exactly one directory, a 64-hex name, matched A's key digest and held `output.docx`. So every count in this change is scoped to the key: `forgottenCopies(lane, key)` counts the entries whose name's SHA-256 equals the key's digest. The global `forgottenDirs` count and its baseline are dropped, along with the `cache/files` parent check that guarded it; `forgottenCopies` keeps the loud failures (unreadable store, non-integer count). The secret-free `forgottenShape` diagnostic stays in the anchor's failure message.

### Anchor (proves the path and "directory name = key")

The forgotten case, once its positive control holds, asserts `forgottenCopies(kA) === 1`. Every cleanup asserts that `removeForgotten` removed exactly `copies` entries, that `forgottenCopies` is then 0, and re-lists to confirm `listed` is now false. Together these prove on the real 9.4.0 server that the store path is right, a key's copy is one directory named by the key, and removing it is what `getForgottenList` sees.

### Rewrite cases (`clean`, `unsaved`) and the typing case

For each: read the open key with `registeredKey(lane, path)` before the Agent turn (or the typing); after `OBSERVE_MS`, record `forgotten: { copies, listed, cleared }`, where `copies` is `forgottenCopies` for that key and `cleared` means `removeForgotten` removed `copies` entries, `forgottenCopies` is then 0, and the re-list no longer holds the key.

- `forgotten` joins `RewriteCaseEvidence`/`rewriteFacts`/`EXPECTED_REWRITE` and the typing evidence/`typingFacts`/`EXPECTED_TYPING`.
- Source prediction: `unsaved` and typing `{ copies: 1, listed: true, cleared: true }`, `clean` `{ copies: 0, listed: false, cleared: true }`.
- The first exact-head stack run is the measurement. Only `copies` and `listed` may follow it (with the docs); `cleared: true` is this spec's SHALL and never change to make a run green. The PR records the measurement.
- `OfficeRewriteLane` (`:289-294`) declares `namespaceRead`; the integration test's `rewriteLane` stand-in (`office-rewrite-stack-fixture.integration.test.ts:521-535`) gains it. The stack wiring already passes it (`platform-stack.stack.test.ts:546`, `:553`).

### Forgotten case

After `recover` and the settle window, record `residue: { copies, listed }` for `kA` (PR #634's question), then clean up and assert `cleared` as above. On failure `kA` reaches the caller through a holder (or callback) the caller passes in, never on the error object, whose own properties and cause chain vitest prints; a stand-in asserts that a failed edit's printed error holds no key. The #624 attack, `present`, `recovered` and `reopenAlert` assertions are unchanged.

### Failure paths

When a case fails after its key is known, it waits the settle window, attempts the cleanup best-effort and rethrows the original error unchanged: same instance and message (`office-rewrite-stack-fixture.integration.test.ts:549-559` asserts `instanceof StackWorkbenchFailure` and the full message), no AggregateError. A cleanup failure on that path is not asserted.

### Docs, written to the measurement

- `docs/EMPLOYEE_GUIDE.md:71`: replace 「已经丢失」: the employee cannot get it back, but the discarded content may remain on the Office server, and the administrator handles it.
- `docs/DEPLOY.md` § 7 (`:284`):
  - where copies live: the bundled Document Server's `/var/lib/onlyoffice/documentserver/App_Data/cache/files/forgotten/<key>/`, in the anonymous volume the image declares;
  - 9.4.0 never expires them, and only the operator (`docker exec`) can reach them;
  - the employee's own recovery works only while the file is unchanged;
  - `up -d` recreation keeps the anonymous volumes, and `down` orphans them.
- `docs/DEPLOY.md` § 8:
  - **Routine cleanup:** `docker exec dsh-team-documentserver find <forgotten> -mindepth 1 -maxdepth 1 -type d -mmin +<minutes> -exec rm -rf {} +` (exact age semantics), knowing it also removes copies an employee could still recover by reopening an unchanged file.
  - **One-time acceptance cleanup:** before step 4's `down`, record the Document Server container's volume names with `docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{.Destination}}{{println}}{{end}}{{end}}' dsh-team-documentserver`; after `down`, `docker volume rm` each exact name. Step 7's prefix check does not see them.
  - **External Document Server:** its storage is the operator's own (one sentence).
- **Excluded:**
  - platform-driven periodic cleanup (the issue's alternative, M, needs triage);
  - access to forgotten copies (#624);
  - XLSX/PPTX;
  - DSH source (D1).

## Triage

```text
Issue type: enhancement (data retention), test cleanup and docs
Fixture level: standard
Upstream suggested level: absent
Blast radius: three stack-lane Office cases (rewrite clean/unsaved, typing, forgotten) gain observation, cleanup and evidence fields; deployment and employee docs
Selected risk packs: Auth / permissions / secrets (the document key never in argv, evidence or failure output); Error handling / rollback / partial outputs (cleanup on failure never masks the case's error); Documentation / migration notes (docs follow the measurement)
Evidence floor: integration stand-ins for the module (digest-only script, no key in failure output, removal count, loud failures on missing dir / non-integer count / failed list read) and for failure-path cleanup rethrowing the original error, each red-proved; pnpm check incl. lint:deps and duplicate-code; exact-head local pnpm test:stack as the measurement and anchor; exact-head VPS lane; Compose anonymous-volume semantics review-only
```

## Risk packs

- **Auth / permissions / secrets — selected.** The key stays in memory, scripts carry only its digest, `removeForgotten` is guarded, and evidence holds counts and booleans. Tasks 1.1–1.3.
- **Error handling / rollback / partial outputs — selected.** The settle wait, best-effort cleanup and unchanged rethrow on failure. Tasks 1.2, 1.3.
- **Documentation / migration notes — selected.** Docs match the measured result; Compose semantics are stated as review-only. Tasks 1.4, 2.2.
- **Not selected:** concurrency, config, product code.

## Acceptance-criteria mapping (#650)

- **AC1** (the #442 scenario's old-key copy recorded as delta and listed; no key, JWT or bytes printed) → 1.2, 2.2.
- **AC2** (`EMPLOYEE_GUIDE` wording matches the measurement) → 1.4, 2.2.
- **AC3** (`DEPLOY.md` § 7 location, no expiry, operator-only; § 8 anonymous-volume disposal and cleanup steps) → 1.4.
- **AC4** (the forgotten case ends at the baseline, asserted; PR #634's residue removed or shown absent) → 1.3, 2.2.
- **AC5** (#624 attack and `recovered` assertions kept) → 1.3, must preserve.

## Must preserve

- `forgottenRows`, `expectedAttack`, the attack, `present`, `recovered` and `reopenAlert` assertions; A's recovery of an unchanged file.
- The existing fields of `EXPECTED_REWRITE` and `EXPECTED_TYPING`, screenshot names and masks.
- A failing case's original error: same instance, same message.
- No key, JWT or file bytes in argv, evidence lines or failure messages.
