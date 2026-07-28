-- 0016: Real per-person credentialed logins (single org: Saigates Limited).
--
-- Replaces the email-only dev-login with password authentication:
--   1. users.password_hash — PBKDF2-SHA256 string ('pbkdf2$iter$salt$hash',
--      see src/lib/password.ts). NULL can never authenticate, so this
--      migration ships NO plaintext and NO working password: the owner
--      provisions each password out of band (scripts/set-password.mjs
--      locally; a one-off hash-only UPDATE in production).
--   2. Rename the single existing organisation to Saigates Limited (it has
--      always been the one org scoping every read/write — id stays 1).
--   3. Seed the two real people, both under organisation 1. The legacy
--      seed row (admin@goodsin.local, id 1) is kept for historical
--      attribution integrity — existing device_events/scan_events reference
--      user_id 1 — but with password_hash NULL it can never log in again.
--
-- Two accounts = two independent audit trails: every attributed write
-- (device_events.user_id, scan_events.user_id, *.created_by_user_id)
-- records which individual acted.

ALTER TABLE users ADD COLUMN password_hash TEXT;

UPDATE organisations SET name = 'Saigates Limited' WHERE id = 1;

-- Identifiers are neutral placeholders (the owner hasn't named the two
-- people): rename via a one-line UPDATE users SET email=?, name=? WHERE id=?
-- at any time — attribution follows the stable user id, not the email.
INSERT OR IGNORE INTO users (email, name, role, organisation_id, password_hash) VALUES
  ('owner@saigates.com', 'Owner',    'admin',    1, NULL),
  ('ops@saigates.com',   'Operator', 'operator', 1, NULL);
