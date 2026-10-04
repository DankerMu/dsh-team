CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'employee')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL
);

CREATE TABLE platform_sessions (
  token_hash TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);

CREATE INDEX platform_sessions_user_id ON platform_sessions (user_id);

CREATE TABLE instances (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users (id),
  status TEXT NOT NULL CHECK (status IN ('stopped', 'starting', 'running', 'error')),
  container_id TEXT,
  upstream_host TEXT,
  upstream_port INTEGER CHECK (
    upstream_port IS NULL
    OR (
      typeof(upstream_port) = 'integer'
      AND upstream_port >= 1
      AND upstream_port <= 65535
    )
  ),
  dsh_cookie TEXT,
  image_tag TEXT,
  last_started_at INTEGER,
  last_activity_at INTEGER,
  last_error TEXT
);

CREATE INDEX instances_status ON instances (status);

CREATE TABLE settings (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL,
  actor_email TEXT,
  target_email TEXT,
  target TEXT,
  source_address TEXT
);

CREATE INDEX audit_events_created_at_id ON audit_events (created_at, id);
CREATE INDEX audit_events_event_type_created_at ON audit_events (event_type, created_at);
CREATE INDEX audit_events_actor_email_created_at ON audit_events (actor_email, created_at);
CREATE INDEX audit_events_target_email_created_at ON audit_events (target_email, created_at);
