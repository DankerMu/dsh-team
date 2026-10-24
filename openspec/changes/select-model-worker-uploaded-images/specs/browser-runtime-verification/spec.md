## ADDED Requirements

### Requirement: Build failure diagnostics recognize single-stage and padded step headers

The bounded build-failure projection SHALL recognize step headers whose stage token is `build`, `runtime` or the fixed unnamed-stage token `stage-0`, separated from `i/N` by one or more spaces, and SHALL project the literal stage token as the phase. Other stage names, out-of-range vertices and steps beyond their total SHALL remain unrecognized, and raw output SHALL still never be retained.

#### Scenario: Single-stage padded RUN header

- **WHEN** the last build header is `#15 [stage-0  2/11] RUN …`
- **THEN** the diagnostic records `{vertex: 15, phase: 'stage-0', step: 2, total: 11, instruction: 'RUN'}`

#### Scenario: Named stage padded header

- **WHEN** the last build header is `#6 [build  2/10] RUN …`
- **THEN** the diagnostic records `{vertex: 6, phase: 'build', step: 2, total: 10, instruction: 'RUN'}`

#### Scenario: Unknown stage stays unknown

- **WHEN** a header names another stage such as `[private-stage  1/1]`
- **THEN** it is not recognized and does not replace an earlier recognized header
