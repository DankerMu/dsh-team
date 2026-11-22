## ADDED Requirements

### Requirement: The deployment guide states the delivered Office editing

The operator deployment guide SHALL describe Office online editing and its per-instance file token protection as delivered. It SHALL state that DOCX and PPTX take the in-instance preview path only when Office online editing is off or the Document Server is not connected.

#### Scenario: An operator reads the Office statements of the deployment guide

- **WHEN** the operator reads the Office statements of the deployment guide
- **THEN** no statement describes Office online editing or the per-instance file token protection as undelivered or pending
- **AND** the DOCX and PPTX preview-path statement is conditional on editing being off or the Document Server not being connected
