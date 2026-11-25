## ADDED Requirements

### Requirement: Office stack double failures report every scrubbed cause and hold nothing raw

This requirement covers three cases:

- an Office stack lane fails and its retirement then also fails;
- a stack workbench session fails and its browser close then also fails;
- the browser close alone fails.

In each case the thrown error's message SHALL carry the scrubbed text of every cause, including the members of an aggregate error, with each reason printed once. The thrown error SHALL NOT be an aggregate error. Neither it nor any of its own properties, its cause or its members SHALL hold unscrubbed text. A workbench session failure SHALL remain a workbench failure that keeps its scrubbed evidence lists. One scrub implementation SHALL produce these texts.

#### Scenario: Lane and retirement both fail

- **WHEN** an editor, forgotten, external or idle lane fails with a message containing a document key
- **AND** its retirement also fails with a message containing a document key
- **THEN** the report shows both reasons with the keys redacted
- **AND** no property of the thrown error holds a raw key

#### Scenario: Session and browser close both fail

- **WHEN** a workbench session fails and closing its browser fails too
- **THEN** the error is still a workbench failure with its scrubbed evidence
- **AND** its message shows both scrubbed reasons

#### Scenario: Only the browser close fails

- **WHEN** the session succeeds and closing its browser fails with a document key in its message
- **THEN** the thrown error carries the reason with the key redacted

### Requirement: Stack test child input never raises an uncaught pipe error

Integration tests that write input to a child process SHALL tolerate the child exiting without reading. An `EPIPE` on stdin SHALL be ignored, and any other stdin error SHALL fail the test.

#### Scenario: The child exits without reading

- **WHEN** a child process exits before reading a large input
- **THEN** no uncaught error is raised and the test file's run exits 0

### Requirement: Masked Office sessions require a Chinese UI

An Office stack session that masks the save-error notice SHALL wait on the DSH page, before its body runs, until the document language is Chinese. If the language never becomes Chinese, the session SHALL fail with a named reason and SHALL take no screenshot of the DSH page, failure screenshot included.

#### Scenario: Non-Chinese UI

- **WHEN** a masked session's DSH page keeps a non-Chinese document language
- **THEN** the session fails with a named reason and takes no screenshot of the DSH page

### Requirement: The forgotten lane's evidence lists its allowed unload sources

The forgotten lane's success evidence SHALL include the scrubbed allowed `unload` violation sources of its edit and recover sessions, so they reach the stack evidence line.

#### Scenario: Allowed violation in the forgotten lane

- **WHEN** a forgotten-lane session records an allowed unload violation
- **THEN** its `<script path>:<line>` source appears in the lane's evidence under that session
