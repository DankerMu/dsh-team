## MODIFIED Requirements

### Requirement: Office stack double failures report every scrubbed cause and hold nothing raw

This requirement covers four cases:

- an Office stack lane fails and its retirement then also fails;
- a stack lane fails and its work-file cleanup then also fails;
- a stack workbench session fails and its browser close then also fails;
- the browser close alone fails.

In each case the thrown error's message SHALL carry the scrubbed text of every cause, including the members of an aggregate error, with each reason printed once. The thrown error SHALL NOT be an aggregate error. Neither it nor any of its own properties, its cause or its members SHALL hold unscrubbed text. A workbench session failure SHALL remain a workbench failure that keeps its scrubbed evidence lists. One scrub implementation SHALL produce these texts.

#### Scenario: Lane and retirement both fail

- **WHEN** an editor, forgotten, external or idle lane fails with a message containing a document key
- **AND** its retirement also fails with a message containing a document key
- **THEN** the report shows both reasons with the keys redacted
- **AND** no property of the thrown error holds a raw key

#### Scenario: Lane and work-file cleanup both fail

- **WHEN** a stack lane fails with a message containing a document key
- **AND** removing its work-directory files also fails with a message containing a document key
- **THEN** the thrown error is a plain error whose message shows both reasons with the keys redacted
- **AND** no property of it holds a raw key, whether or not a retirement wrapper surrounds the lane

#### Scenario: Session and browser close both fail

- **WHEN** a workbench session fails and closing its browser fails too
- **THEN** the error is still a workbench failure with its scrubbed evidence
- **AND** its message shows both scrubbed reasons

#### Scenario: Only the browser close fails

- **WHEN** the session succeeds and closing its browser fails with a document key in its message
- **THEN** the thrown error carries the reason with the key redacted

## ADDED Requirements

### Requirement: Stack lane assertions never print a secret

An assertion in an Office or sidebar stack real-lane fixture SHALL NOT print a document key, a JWT or a URL query when it fails: not in its expected value, its received value or its message. This applies whenever a printed part is built from lane data (page, DOM or URL state, console or network records, Document Server or Docker output, administrator configuration read back) that is not first scrubbed. A check that a value is free of a secret SHALL fail without printing that secret. A single lane failure rethrown unchanged SHALL therefore carry no such secret from these assertions.

#### Scenario: The forgotten positive control contains A's key

- **WHEN** the forgotten lane's positive control or present list contains A's document key
- **THEN** the check fails
- **AND** nothing it prints contains A's key

#### Scenario: An assertion message built from page state

- **WHEN** an Office stack assertion whose message is built from page state fails while that state holds a document key
- **THEN** the printed message carries the key redacted
