ALTER TABLE posts ADD COLUMN hidden_at timestamptz;
ALTER TABLE comments ADD COLUMN hidden_at timestamptz;
ALTER TABLE notifications ADD COLUMN comment_id text REFERENCES comments(id) ON DELETE SET NULL;
CREATE INDEX notifications_comment_idx ON notifications(comment_id) WHERE comment_id IS NOT NULL;

-- Keep the original safety verdict in moderation_cases. The entity's review
-- gate is understood by older web/workers, so rolling back the application
-- cannot expose hidden content or let a late approval make it public again.
CREATE FUNCTION admin_content_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.privacy_restore',true)='on' THEN RETURN NEW; END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    NEW.moderation_status := 'deleted';
  ELSIF NEW.hidden_at IS NOT NULL THEN
    NEW.moderation_status := 'review';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_content_visibility BEFORE INSERT OR UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION admin_content_visibility_guard();
CREATE TRIGGER admin_content_visibility BEFORE INSERT OR UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION admin_content_visibility_guard();
ALTER TABLE posts ADD CONSTRAINT posts_hidden_not_public CHECK (hidden_at IS NULL OR moderation_status<>'approved');
ALTER TABLE comments ADD CONSTRAINT comments_hidden_not_public CHECK (hidden_at IS NULL OR moderation_status<>'approved');
