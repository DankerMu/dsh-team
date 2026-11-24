## ADDED Requirements

### Requirement: The platform UI CI lane uses a pinned browser image matching the Playwright package

The platform UI CI lane SHALL obtain its browser and system libraries from a container image pinned by digest. The Playwright version that the image itself records SHALL equal the repository's pinned Playwright test package. The lane SHALL NOT install operating-system packages at run time. It SHALL fail when the two versions differ, or when the image's version record is missing or unreadable. Its timeout, assertions and screenshot evidence SHALL stay unchanged.

#### Scenario: The Ubuntu package mirror is slow or unavailable

- **WHEN** the platform UI lane runs while the Ubuntu package mirror is slow or returns errors
- **THEN** the lane fetches no operating-system packages
- **AND** its outcome does not depend on the Ubuntu package mirror

#### Scenario: The Playwright package is bumped without the image

- **WHEN** the pinned Playwright test package version differs from the version recorded in the image
- **THEN** the lane fails before running the tests and names both versions
