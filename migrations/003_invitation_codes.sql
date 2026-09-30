CREATE TABLE invitation_codes (
  id text PRIMARY KEY,
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 120),
  code_hash text UNIQUE NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text NOT NULL CHECK (char_length(code_hint) = 4),
  created_by text NOT NULL REFERENCES "user"(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_by text UNIQUE REFERENCES "user"(id),
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((used_by IS NULL) = (used_at IS NULL)),
  CHECK (used_at IS NULL OR used_at < expires_at)
);
CREATE INDEX invitation_codes_created ON invitation_codes(created_at DESC, id DESC);

-- Redeem in the account-creation transaction using a conditional UPDATE with
-- used_by IS NULL, used_at IS NULL, revoked_at IS NULL and expires_at > now().
-- Revoking a used invitation leaves used_by/used_at and the member intact.
