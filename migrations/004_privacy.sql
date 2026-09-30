ALTER TABLE profiles
  ADD COLUMN privacy_version text,
  ADD COLUMN privacy_accepted_at timestamptz,
  ADD COLUMN deleted_at timestamptz;
ALTER TABLE registrations
  ADD COLUMN contact_consent_version text,
  ADD COLUMN contact_consented_at timestamptz;
ALTER TABLE media ADD COLUMN ai_consent boolean NOT NULL DEFAULT false;

-- Keep the object key until deletion succeeds. The job and this outbox row are
-- committed with the account closure, so an OSS outage cannot lose the request.
CREATE TABLE privacy_object_deletions (
  id text PRIMARY KEY,
  storage_key text UNIQUE NOT NULL,
  storage_backend text NOT NULL CHECK(storage_backend IN ('local','oss')),
  storage_location text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A row lock serializes closure with writes that passed an earlier HTTP check.
-- Missing profiles are allowed only for Better Auth's initial user creation;
-- account closure keeps a profile tombstone, which must never become writable.
CREATE FUNCTION privacy_guard_open_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_id text; closed_at timestamptz;
BEGIN
  IF current_setting('app.privacy_restore',true)='on' THEN RETURN NEW; END IF;
  FOR account_id IN
    SELECT DISTINCT to_jsonb(NEW)->>field FROM unnest(TG_ARGV) AS args(field)
    WHERE to_jsonb(NEW)->>field IS NOT NULL ORDER BY 1
  LOOP
    SELECT deleted_at INTO closed_at FROM profiles WHERE user_id=account_id FOR SHARE;
    IF FOUND AND closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Account is closed' USING ERRCODE='23514', CONSTRAINT='privacy_account_closed';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON communities FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('owner_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('author_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('author_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON media FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('owner_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('organizer_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON registrations FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON reactions FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON follows FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('follower_id','following_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON blocks FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('blocker_id','blocked_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('reporter_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON agent_grants FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON request_keys FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON audit_logs FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('user_id');
CREATE TRIGGER privacy_guard BEFORE INSERT ON invitation_codes FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('created_by');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "session" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "account" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "oauthClient" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON "oauthConsent" FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('userId');

-- Verification values also include non-JSON phone codes. Parse only structured
-- OAuth values, without leaking the codes or access credentials into logs.
CREATE FUNCTION privacy_verification_user(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN (value::jsonb)->>'userId';
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;
CREATE FUNCTION privacy_guard_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_id text; closed_at timestamptz;
BEGIN
  IF current_setting('app.privacy_restore',true)='on' THEN RETURN NEW; END IF;
  account_id := privacy_verification_user(NEW.value);
  IF account_id IS NULL THEN
    SELECT id INTO account_id FROM "user" WHERE "phoneNumber"=NEW.identifier;
  END IF;
  IF account_id IS NOT NULL THEN
    SELECT deleted_at INTO closed_at FROM profiles WHERE user_id=account_id FOR SHARE;
    IF FOUND AND closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Account is closed' USING ERRCODE='23514', CONSTRAINT='privacy_account_closed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON verification FOR EACH ROW EXECUTE FUNCTION privacy_guard_verification();
