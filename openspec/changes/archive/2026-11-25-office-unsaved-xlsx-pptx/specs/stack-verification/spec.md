## ADDED Requirements

### Requirement: Unsaved rewrite cases cover XLSX and PPTX

Besides DOCX, the Office rewrite lane SHALL have an unsaved rewrite case for XLSX and one for PPTX. Their expected facts SHALL be pinned from measurement on the real stack:

- whether the refreshed-away session's save is refused;
- the notices;
- each side's nonce;
- the forgotten copy.

Where the save typing overwrites the typed edit's location, so that a surviving typed nonce cannot be observed, the discard SHALL be proven by the refresh, the refused save and the forgotten copy instead.

#### Scenario: An unsaved XLSX or PPTX edit meets an Agent rewrite

- **WHEN** the employee types into an XLSX or PPTX editor without saving, and the Agent then rewrites the file
- **THEN** the lane's facts equal the measured expectation for that format

#### Scenario: The save outcome changes

- **WHEN** an unsaved case's save-refusal outcome or forgotten copy differs from its measured expectation
- **THEN** the case fails

### Requirement: Each rewrite case asserts whether the close rewrote the saved file

Each clean and unsaved Office rewrite case SHALL record whether the file's digest after the editor closed differs from its digest after the save. The lane SHALL assert that the close rewrote the file in the DOCX, XLSX and PPTX clean cases and in the DOCX unsaved case. For a new unsaved case, the lane SHALL assert the outcome its two measurement runs agree on, and SHALL keep it as evidence only where they disagree.

#### Scenario: A close that does not rewrite the file

- **WHEN** the file's digest after the close equals its digest after the save, in a case whose expectation is that the close rewrites it
- **THEN** the case fails
