## ADDED Requirements

### Requirement: Owned image cleanup uses the canonical reference of untagged names

Verification-case and journal-driven owned image retirement SHALL resolve an untagged image name to its canonical `<name>:latest` reference and use that one reference for ownership inspection, absence recognition, removal and post-removal confirmation. Tagged references and immutable image IDs SHALL be used unchanged. Absence SHALL be accepted only for the daemon's exact diagnostic naming that canonical reference; other diagnostics, exit statuses and label mismatches SHALL still fail.

#### Scenario: Untagged owned image never created or already removed

- **WHEN** cleanup retires an untagged owned image name that Docker reports as `No such image: <name>:latest`
- **THEN** cleanup treats the image as retired instead of reporting a cleanup failure, and a failed build still reports its own failure

#### Scenario: Foreign or ambiguous absence evidence

- **WHEN** the inspect reports another reference, a non-1 exit status, or a mismatched ownership label
- **THEN** cleanup fails closed exactly as before and no foreign image is removed
