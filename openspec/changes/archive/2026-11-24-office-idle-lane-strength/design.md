# Design

## Change surface

- `office-idle-stack-fixture.ts`: `officeIdle`, `loaded`, `officeIdleScenario`, `officeIdleLine`
- its integration test
- `docs/LOCAL_STACK.md:199`

## Must preserve

- `heldRunning`/`idleRetired` semantics and their assertions
- `retiringOnError` restore on failure, and the failure-message composition
- the lane's order and timing
- A ending idle-stopped, which the external lane (`platform-stack.stack.test.ts:553`) needs
- every existing evidence field
- `platform-stack.stack.test.ts` unchanged: the snapshot lives inside `officeIdleScenario`
- the 800-line and complexity limits

## Must add/change

- `loaded(admin, email, operator, idle, readFonts, hold = heldRunning)`, exported, returning `{ fonts, hold }`. `officeIdle` calls it in place of the closure.
- `officeIdleScenario(lane, body = officeIdle)`, with the body injectable. It takes a `runtime-config` snapshot before, and a read-back plus deep-equal check after its own restore, recorded as `restored: true`.
- `officeIdleLine` carries `restored`.

## Governing invariant

The idle lane leaves `runtime-config` exactly as it found it, and changes the idle minutes only after the font check has passed.

## Sibling surfaces

- `idleMinutes`, whose restore is already covered at `:87-101`
- `retiringOnError`
- the external lane's start state
- `LOCAL_STACK.md:199`. Its phrase "A 只开着 DOCX 编辑器" is inaccurate because the workbench is also open. This change only corrects the wording. Attributing the keep-alive to the editor is C2's work, in a later slice.

## Seams under test

- `loaded` with a stand-in admin (a request recorder) and a stand-in `hold`
- `officeIdleScenario` with a stand-in body, reusing the existing `platform()` admin stub (integration test `:43-85`) for the snapshot and read-back
- `loaded` takes the font-name reader as a parameter (`officeIdle` passes `editorFontNames`), so its tests need no `as`-cast editor stand-in

## Required evidence

- C1-a: `loaded`'s success path leaves a restore that PUTs the original configuration. This is red when the `:187` assignment is dropped.
- C1-b: `officeIdleScenario` calls the body-assigned restore exactly once on success. This is red when the `:212` call is deleted.
- C3: when `fontsShown` fails, there are zero PUTs and the restore is still the no-op. This is red when `:186` and `:187` are swapped.
- Stack: `restored: true`.

## Non-goals

C2 (its own slice), slices A and B, product code.

## Review focus

- the seams do not change runtime behaviour
- the snapshot sits inside `officeIdleScenario`
- the external lane's start state is preserved
