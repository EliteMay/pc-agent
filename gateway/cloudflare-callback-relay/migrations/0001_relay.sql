CREATE TABLE relay_pending (
  state_hash TEXT PRIMARY KEY,
  binding TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','ready','consumed')),
  envelope TEXT,
  claim_id TEXT
);
CREATE INDEX relay_pending_expiry ON relay_pending(expires_at);
CREATE TABLE relay_nonces (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX relay_nonce_expiry ON relay_nonces(expires_at);
CREATE TABLE relay_limits (scope TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
