# Managed Chinese Web composition

This dependency-free plugin targets **DSH npm 0.2.0-rc.2 exactly**. `client.js` is
its delivered classic-script artifact, not generated output. It calls the
released public `ctx.locale.setLocale('zh')` once on every plugin load. It does
not use native transport/locale globals, impersonate localhost, alter DSH,
hide DOM, or intercept onboarding.

`cordis.patch.yml` is the canonical composition patch: insert this plugin and
disable **only** `ui-settings-models`. That removes the personal provider/key
settings page and its Preview Notice/API-key onboarding. General settings,
model execution, `ui-model-selection`, the composer model seat, and `/model`
remain in the roster. This is not a replacement model provider.

## Delivery

The package declares the exact DSH peer pin using the published compatibility
idiom. Before activating an overlay-inserted local package, also require exact
`dsh --version` equality with `package.json.peerDependencies['@deepseek-ai/dsh']`;
do not apply an `allow-version` exemption. The probe performs this equality check
against its image and validates the manifest before copying. Coverage of the
native startup peer check for an overlay-only package is not yet established;
the probe's explicit comparison is the operative pin guard for that path.

For offline profile delivery, copy `package.json`, `index.js`, `client.js`, and
`cordis.patch.yml` to
`$DSH_HOME/profiles/web/node_modules/@dsh-team/zh-locale/`, then apply the canonical
patch after the Web bundle (e.g. through `--patch`). The importable ESM host half
uses the released pure-UI `apply` convention, without host-side behavior; browser
behavior is implemented exclusively by the client artifact. No package manager,
registry, build, or third-party dependency is needed at runtime. Production image
population and managed-config generation
remain separate tasks; do not copy probe-created Session state as an image seed.

## Parent verification commands (giap-vps)

Use the existing executable Chrome path in `CHROME_BIN`:

```sh
pnpm probe:first-run
PROBE_COMPOSITION_FAULT=missing-plugin pnpm probe:first-run
PROBE_COMPOSITION_FAULT=wrong-plugin pnpm probe:first-run
PROBE_COMPOSITION_FAULT=reenabled-notice pnpm probe:first-run
```

To exercise preservation in the same owned instance **before cleanup**:

```sh
PROBE_COMPOSITION_EXTRA_PATCH=/absolute/non-secret-two-model-fixture.yml \
  PROBE_COMPOSITION_PRESERVE_MODELS='Fixture A,Fixture B' pnpm probe:first-run
```

Use the two actual display names declared by the fixture. This opt-in mode runs
only after both initial entry and refresh are accepted. It opens General,
verifies the language/version content, lists both models, selects each, verifies
the trigger and `aria-checked` state, records a preservation screenshot, rejects
new console errors or prompt requests, and only then permits normal cleanup.
The default matrix still closes all instances; it does not leave a browser for
manual inspection.

The original baseline/overlay/preseed/CLI/combined observations remain separate.
Composition receives only the discovered workspace storage and the delivered
package bytes in its fresh profile. Artifact SHA256 identities are retained in
`composition-artifacts.json`. Its overlay appends the canonical patch verbatim,
without the ineffective server locale/acknowledgement settings. An optional
`PROBE_COMPOSITION_EXTRA_PATCH=/absolute/non-secret-fixture.yml` appends an
explicit trial-only patch after the canonical patch, for configured-model UI
preservation checks; it cannot change the expected roster.

The browser's **delivered** `__DSH_BOOT__` graph must equal the independently
observed baseline roster minus `@deepseek-ai/dsh-client-ui-settings-models` plus
`@dsh-team/zh-locale`. It must retain General settings and model selection.
Malformed/unknown/mismatched rosters fail, rather than interpreting an absent
WelcomeNoticeStore as acknowledgement. Readiness also requires actually rendered
and usable session/settings controls, workspace selection, and an editable
composer. Chinese controls, no Notice, marker type/clear, host `/data/work`
binding, and zero new console errors are checked. A real `Page.reload` repeats
the same acceptance on a new document without seeding browser storage or
clicking settings/dismissal/setup UI. `accept.json` contains both entry results;
`composition-homepage.png` and `composition-homepage-reload.png` are retained.

Expected counterexamples:

- `missing-plugin`: no package bytes are installed; launch/registration must
  fail (`start-or-registration`, nonzero).
- `wrong-plugin`: disposable client bytes register a different loader id while
  the manifest still advertises the expected package; registration/activation,
  console, or rendered-readiness checks must reject it (nonzero). A plausible
  boot roster alone cannot pass.
- `reenabled-notice`: a subsequent patch reenables the original row; the
  delivered roster fails with `stage=composition error=roster-mismatch` before
  any absence/acknowledgement verdict (nonzero).
- A delayed session/settings render times out; missing/malformed baseline or
  delivered graph, copy failures, and pin mismatch are harness-inconclusive,
  not a successful recipe. Any earlier trial's harness error takes precedence
  over a later successful composition.

## General and model-selection preservation seam

The opt-in mode above exercises these **after** first-entry and reload acceptance,
on the same disposable composition instance configured with two non-secret models.
Reuse the existing `llm-pi-ai.config.providers.intranet` plus `agent-default-model` overlay shape
from `verify/phase0/managed.patch.yml`. Models must come from the real configured
catalog; do not submit a model prompt, fabricate execution, or install a
fallback provider. The first-run matrix itself intentionally remains key-free.

Packed 0.2.0-rc.2 UI selectors:

1. Open `button[aria-label="设置"]` (English control: `Settings`). The actual
   settings dialog is `[role="dialog"][data-shortcut-modal="settings"]`.
2. Click its `nav button` whose normalized text is `通用设置` (`General`), then
   assert `aria-current="true"` and visible `[data-slot="settings.general.item"]`
   content, including the language row (`语言`) and current-version row.
   Close via the dialog button with accessible text `关闭` (`Close`), or Escape.
3. Open `button[aria-label^="选择模型"]` (unselected:
   `button[aria-label="请选择模型"]`; English: `button[aria-label^="Select model"]`).
   Wait until loading has completed; the trigger's loading label is
   `正在加载模型…` (`Loading models…`), not readiness.
4. In `[aria-label="模型与推理等级"]` (`Model and reasoning effort`), click the
   root `button[role="menuitem"]` containing `模型` (`Model`). The model list is
   `[role="menu"][aria-label="模型"]` (`Model`). Its model choices are
   `button[role="menuitemradio"][title="<configured model display name>"]`.
5. Assert that both configured names are listed. Select each in turn; wait for
   the trigger caption/aria-label to name the selection, reopen/drill, and assert
   that option has `aria-checked="true"`. Capture screenshots and new console
   errors. No Send/Enter-in-composer action is part of this check.

The real UI obtains its catalog via `remote.session.modelCatalog()` and selects
via `remote.session.selectModel({sessionId, provider, model})` (packed
`ui-model-selection/lib/client.js`). Observe those real successful responses and
model-selection projection changes if needed; API-only selection is not proof
that the composer control works. Assert no `/api/session/prompt` request occurs.
The parent owns this independent UI exercise and the API three-cycle regression.

## Verification status

Parent verification on giap-vps (DSH 0.2.0-rc.2, Node 24.13.1, Chrome 140):
the root first-run probe passed on a fresh non-loopback English-language browser
and on reload, with Chinese controls, no Notice, successful marker type/clear,
and no console errors. The configured-model run passed General settings and
selection of both fixture models without a prompt request. All three documented
composition fault cases returned harness-inconclusive rather than success.
These results do not establish production image population or target Ubuntu 22.04 behavior.
The package has no branching application logic to unit-test without mock-wiring;
the real pinned browser/probe boundary is the verification oracle. The existing
JS lint and dependency checks include `plugins/`, with browser globals declared
for the classic artifact. The canonical JS entries use `@ts-check`; the existing
root TypeScript command also checks them in an isolated strict checked-JS project,
using a narrow structural declaration of the packed public loader/locale interfaces.
No new coverage exclusion, dependency,
workspace, compiler bypass, or unexecuted unit-test project is introduced.
