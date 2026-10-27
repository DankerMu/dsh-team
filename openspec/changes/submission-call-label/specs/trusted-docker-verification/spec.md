## ADDED Requirements

### Requirement: Unresolved submissions identify their operation and test without sensitive detail

Every shared-Engine submission published by the Docker CLI wrapper, the tracked Engine HTTP client or a deployed observer SHALL record, in its journal `submitted` row, a `call` label made only of a transport (`cli` or `http`), an operation from a fixed vocabulary (a CLI verb and known group subcommand, or an HTTP method with an endpoint template whose resource segments are `{id}`; otherwise `other`), and the basename of the issuing test file under `platform/test/` (otherwise `unknown`). The label SHALL NOT contain arguments, resource names or identifiers, query strings, paths, environment values or credentials. The journal parser SHALL accept rows with a valid label and rows written before the label existed, and SHALL reject any other label shape. Settlement and cleanup verdicts SHALL be unchanged.

#### Scenario: An unresolved HTTP mutation is attributable

- **WHEN** a test's tracked Engine client submits `POST /containers/<id>/kill` and the request fails outside the qualified rejection matrix
- **THEN** the submission stays unresolved, custody cleanup stays unconfirmed, and its `submitted` row names `http`, `POST /containers/{id}/kill` and the issuing test file

#### Scenario: Labels never carry sensitive detail

- **WHEN** a CLI or HTTP mutation includes resource names, IDs, query parameters or arbitrary arguments
- **THEN** the recorded label contains only the fixed-vocabulary operation and the test file basename

#### Scenario: Older journals remain readable

- **WHEN** custody assesses a journal whose rows predate the label
- **THEN** the assessment is identical to before, and a row with a malformed label is rejected as malformed evidence
