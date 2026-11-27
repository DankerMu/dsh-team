## MODIFIED Requirements

### Requirement: Stack test child input never raises an uncaught pipe error

Integration tests, and the Docker command boundary they share, that write input to a child process SHALL tolerate the child exiting without reading. An `EPIPE` or `ECONNRESET` on stdin (the child closed its end without reading) SHALL be ignored, and any other stdin error SHALL fail the test. In the Docker boundary's asynchronous command, any other stdin error SHALL terminate the child and settle the command's result as failed with that error, within the command's timeout, never as an uncaught exception or an unhandled rejection.

#### Scenario: The child exits without reading

- **WHEN** a child process exits before reading a large input
- **THEN** no uncaught error is raised and the test file's run exits 0

#### Scenario: The Docker command's child exits without reading

- **WHEN** the Docker boundary's asynchronous command is given an input far larger than a pipe buffer and its child exits without reading it
- **THEN** the result carries the child's own status and output with no error, and the test file's run exits 0

#### Scenario: The Docker command's stdin fails with another error

- **WHEN** the Docker boundary's asynchronous command's stdin fails with an error other than `EPIPE` or `ECONNRESET` while its child would never exit
- **THEN** the child is killed, the result settles before the command's timeout with a null status and that error, and no uncaught exception or unhandled rejection is raised
