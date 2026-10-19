# Tasks

- [x] 1. Record the pinned upstream cause and write a behavioral process regression that fails on the old package command; cover absent env startup and native watched-source replacement without reading real configuration.
- [x] 2. Select native watch arguments in the foreground launcher, preserve native present-file parsing/precedence and failure semantics, and prove regression GREEN plus foreground process settlement. Existing-but-unreadable files use the required native env flag: the optional native flag was observed silently omitting them; the rejection regression now passes.
- [ ] 3. Exercise actual `pnpm dev` with genuine source/web build, real Docker prerequisites and fresh private data on trusted Node24.13.1/pnpm10.34.6: absent/present env health, source reload and clean shutdown; update existing development guidance.
- [ ] 4. Complete canonical checks, risk-scaled cross-review, exact-reviewed-head standalone Compose/full Docker with independent cleanup/host fence, protected CI/merge/main CI and synchronized archive delivery.

## Risk mapping

- CLI/script entry and config/setup:1–3, actual package command and native env semantics.
- File IO/path safety and secrets:1–3, owned temp roots, no real env reads/writes, no placeholder file, no raw credential output.
- Concurrency/ordering and error/settlement:2–3, build-before-start, native watcher replacement and owned process closure; no new supervisor/retry.
- Legacy/release compatibility:2–4, pinned tools and Linux/macOS, background/production entrypoints unchanged, no dependencies.
- Documentation:3, optional input and explicit restart after first env creation.
- Schema/public API/auth/resource discovery: not changed; existing production lifecycle remains authoritative.
