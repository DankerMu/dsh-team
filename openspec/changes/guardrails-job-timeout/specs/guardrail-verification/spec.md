## ADDED Requirements

### Requirement: The guardrail self-test job's time limit has a measured basis

The CI job that runs the guardrail self-test SHALL have a time limit that states its measured basis next to the value: the sampling window, the sample size, the step's median, p90 and maximum duration, and the job overhead. The limit SHALL leave room for the slowest measured run plus headroom for case growth. A job cancelled at its limit SHALL never count as success.

#### Scenario: A slow runner finishes the self-test

- **WHEN** the self-test step runs as slowly as the slowest measured run
- **THEN** the job completes at least 2 minutes before its time limit instead of being cancelled
