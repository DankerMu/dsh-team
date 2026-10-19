CREATE TABLE creation_attempts (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id),
  attempt_id TEXT NOT NULL UNIQUE,
  account_created_at INTEGER NOT NULL,
  image_id TEXT NOT NULL,
  image_tag TEXT NOT NULL,
  network_id TEXT NOT NULL,
  network_subnet TEXT NOT NULL,
  overlay_path TEXT NOT NULL,
  upstream_mode TEXT NOT NULL CHECK (upstream_mode IN ('network', 'published-loopback')),
  prior_instance_hash TEXT NOT NULL,
  container_id TEXT,
  created_at INTEGER NOT NULL
);
