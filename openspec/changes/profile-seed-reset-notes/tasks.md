## 1. Implementation

- [ ] 1.1 `docs/DEPLOY.md`: after `:59`, the upgrade paragraph — silent for profile-loaded plugins, per-plugin groups (`zh-locale` code marked inferred), the reset's cost, no automatic sync in stage 2.
- [ ] 1.2 `docs/EMPLOYEE_GUIDE.md`: the reset-prerequisite note before the two Office sections, naming the affected behaviours and not the `office-hints` notices.
- [ ] 1.3 `.github/PULL_REQUEST_TEMPLATE.md`: the Risk checkbox covering `images/dsh-user/` patches and preinstalled `plugins/<id>/` files.

## 2. Verification

- [ ] 2.1 Every docs claim checked against the cited code lines (review-only: `docs/` is prettier-ignored and outside `lint:agents`); `pnpm fmt:check` exit 0 for the template and fixture.
- [ ] 2.2 CI green on the frozen head.
