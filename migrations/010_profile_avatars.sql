-- Additive avatar ownership. Existing uploads keep their original post usage.
ALTER TABLE media ADD COLUMN usage_kind text NOT NULL DEFAULT 'post'
  CHECK (usage_kind IN ('post','avatar'));
ALTER TABLE media ADD CONSTRAINT media_avatar_unattached CHECK (usage_kind<>'avatar' OR post_id IS NULL);
ALTER TABLE profiles ADD COLUMN avatar_media_id text REFERENCES media(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX profiles_current_avatar ON profiles(avatar_media_id) WHERE avatar_media_id IS NOT NULL;

-- A rolled-back worker does not know how to inspect/apply avatar images. It
-- must not approve a new avatar draft as text-only and advance the draft head.
CREATE FUNCTION moderation_guard_profile_avatar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE avatar_id text;
BEGIN
  IF current_setting('app.privacy_restore',true)='on' OR NEW.kind<>'profile' OR NEW.status<>'approved' OR NOT (NEW.payload ? 'avatarMediaId') THEN RETURN NEW; END IF;
  avatar_id := NEW.payload->>'avatarMediaId';
  IF avatar_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM profiles p JOIN "user" u ON u.id=p.user_id WHERE p.user_id=NEW.author_id AND p.deleted_at IS NULL AND p.avatar_media_id IS NULL AND u.image IS NULL) THEN RETURN NEW; END IF;
  ELSIF EXISTS(SELECT 1 FROM profiles p JOIN "user" u ON u.id=p.user_id JOIN media m ON m.id=p.avatar_media_id
    WHERE p.user_id=NEW.author_id AND p.deleted_at IS NULL AND m.id=avatar_id AND m.owner_id=NEW.author_id
      AND m.usage_kind='avatar' AND m.post_id IS NULL AND m.moderation_status='approved' AND u.image='/api/v1/media/'||avatar_id) THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Avatar draft requires its approved image to be applied first' USING ERRCODE='23514', CONSTRAINT='moderation_profile_avatar_applied';
END;
$$;
CREATE TRIGGER moderation_profile_avatar BEFORE INSERT OR UPDATE OF status ON content_drafts FOR EACH ROW EXECUTE FUNCTION moderation_guard_profile_avatar();
