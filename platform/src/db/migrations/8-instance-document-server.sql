ALTER TABLE instances ADD COLUMN document_server_mode TEXT CHECK (
  document_server_mode IN ('bundled', 'external', 'unconfigured')
);
ALTER TABLE instances ADD COLUMN document_server_container_id TEXT;
ALTER TABLE instances ADD COLUMN document_server_reason TEXT CHECK (
  document_server_reason IN ('absent', 'identity-mismatch')
);
