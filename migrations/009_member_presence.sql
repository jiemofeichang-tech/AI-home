-- One server timestamp per account: multiple tabs/devices count as one member.
-- Existing accounts remain unobserved until their first browser heartbeat.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
