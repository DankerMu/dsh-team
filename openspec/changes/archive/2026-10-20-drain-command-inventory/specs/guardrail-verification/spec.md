# Spec Delta

## ADDED Requirements

### Requirement: Documented command membership remains exact as the inventory grows

The documented-command gate MUST accept every documented non-builtin command whose complete literal name exists in the root package script inventory, and MUST reject a missing complete name with the existing missing-command diagnostic. Adding unrelated valid scripts MUST NOT turn an existing command into a missing-command result through early consumer termination. Strict shell error handling, supported Bash versions, documented input selection and fixture isolation MUST remain intact.

#### Scenario: Large valid inventory includes the documented command

- **WHEN** unrelated valid script names enlarge the inventory beyond an ordinary pipe buffer and a documented command remains present
- **THEN** the gate accepts it without a producerSIGPIPE being misclassified as missing membership

#### Scenario: Only a prefix or near-match exists

- **WHEN** a documented complete name is absent while a longer script name shares its prefix
- **THEN** the gate exits nonzero and identifies the absent complete name

#### Scenario: Positive regression is followed by other gate cases

- **WHEN** the self-test finishes its expanded valid-inventory case
- **THEN** it restores the owned fixture before subsequent cases, preserves all existing rejection cases and leaves no fixture residue
