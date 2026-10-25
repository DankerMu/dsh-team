## ADDED Requirements

### Requirement: Source-main startup verification retains graceful-stop failure evidence

When startup verification of the actual source main process requests graceful shutdown and the process then exits nonzero or by signal, the printed failure message SHALL name the actual exit code and signal and include the bounded tail (at most 8192 characters, with an explicit truncation marker) of the process's already-captured stderr. If the main observation had already completed, its health status, exit code and bounded stderr SHALL appear in that same message; if the observation had failed, its original error SHALL remain attached as the reported failure's `cause`. The graceful-stop criterion (stop requested only while alive; any nonzero code or non-null signal fails), signal semantics, deadlines and consumer assertions SHALL remain unchanged. The evidence classifies only the exit class (silent nonzero exit, nonzero exit with an error dump, or signal termination); it SHALL NOT claim a cause or a source line.

#### Scenario: Graceful stop ends nonzero after a successful observation

- **WHEN** the observed main served health and, after the stop request, exits with code 1 and stderr text
- **THEN** the verification fails with a message naming code 1, signal null, the stderr tail, and the observation's health status and exit code

#### Scenario: Graceful stop ends by signal after an observation error

- **WHEN** the observation itself failed and the stop request then ends the process by a signal
- **THEN** the verification fails with a message naming that signal, and the original observation error is its `cause`

#### Scenario: Graceful stop succeeds

- **WHEN** the process exits with code 0 and no signal after the stop request, or had already exited before it
- **THEN** the observation result is returned, or the original observation error is rethrown as the same object
