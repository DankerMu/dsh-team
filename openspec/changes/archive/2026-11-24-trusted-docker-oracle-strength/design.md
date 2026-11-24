# Design

## Change surface

- the killOwner case's scene regex
- the tree walk plus one positive case
- the preload template's `post-close-member` mode
- the receipt reader
- the two assertions of the `post-close-member` case

## Must preserve

- every existing assertion in both files; `memberTiming`'s message may gain the close time
- the custody `scene` (`custody.integration.test.ts:196`)
- the second `post-close-member` case, "retires a pre-started post-close member that was never told to exit" (`:777-793`): it runs under the preload, still ends `settled: false`, and has no receipt assertion
- the four `deniedGroupObservations` modes and the slow-owner `Atomics.wait`, unchanged
- the preload transparently returns and throws what `kill` returns and throws; `post-close-member` denies nothing; `start`/`cancel`/`status` load the preload but never count or write
- `scripts/trusted-docker-*.mjs` unchanged
- size limits: custody test ≈795/800 effective lines; `trusted-docker-fixture.ts` ≈783/800, where template `//` lines count; `prepareCustodyRepository` ≈183/200 function lines. The receipt reader goes in a new `trusted-docker-*-fixture.ts`.

## Governing invariant

At the owner's first post-close group observation, the group still holds a live member. That member exits after the observation and within the window.

## Sibling surfaces

- the denied-mode preload
- slow-owner
- the second post-close-member case
- `memberTiming`
- custody `scene`
- `fixture.ts:462` and custody `:708`, the test-process `groupIsAbsent` calls. They are outside the owner, so they are not counted.

## Seams under test

- the owner-side preload receipt: the command match count, `closedAt`, `firstObservedAt`, `firstPresent`, `presentPolls`, `preClosePolls`
- the shared tree walk

## Required evidence

- the mutants in tasks 1.3, with their before and after texts
- three local green runs
- CI `layer3-integration` green on Linux

If procps rejects `ps -axo pid,ppid,pgid,stat,etime,command` on Linux, fix the walk; never relax (1A).

## Assumptions

- On Darwin, `ps` could still list an unreaped owner zombie: `fixture.ts:460` records ESRCH being returned for unreaped processes. Between `observeProcess` and `ls -R` this is unlikely. If it shows up, the (1A) end anchor fails loudly.

## Non-goals

- product changes (the alternative of exposing close in the terminal is rejected under YAGNI)
- #656 budgets, #653, #655

## Review focus

- the receipt path and its write timing
- EPERM counting
- the premise lock
- argv gating
- transparency
- the size limits
