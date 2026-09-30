-- Text edits stay private until their content review is approved. Keeping the
-- draft separate preserves the last approved public version during review.
CREATE TABLE content_drafts (
  id text PRIMARY KEY,
  author_id text NOT NULL REFERENCES "user"(id),
  kind text NOT NULL CHECK (kind IN ('profile','community','announcement','event','recap')),
  target_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','review','rejected','approved','deleted')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_drafts_author ON content_drafts(author_id,created_at DESC);
CREATE INDEX content_drafts_target ON content_drafts(kind,target_id);
CREATE TRIGGER privacy_guard BEFORE INSERT OR UPDATE ON content_drafts FOR EACH ROW EXECUTE FUNCTION privacy_guard_open_account('author_id');
