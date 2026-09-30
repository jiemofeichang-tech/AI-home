-- A moderation removal differs from an organizer cancelling an activity.
ALTER TABLE events ADD COLUMN moderation_removed_at timestamptz;
ALTER TABLE communities ADD COLUMN moderation_removed_at timestamptz;
CREATE TABLE content_draft_heads (
  kind text NOT NULL,
  target_id text NOT NULL,
  current_draft_id text NOT NULL REFERENCES content_drafts(id) ON DELETE CASCADE,
  PRIMARY KEY(kind,target_id)
);
INSERT INTO content_draft_heads(kind,target_id,current_draft_id)
  SELECT DISTINCT ON (kind,target_id) kind,target_id,id FROM content_drafts
  WHERE status='approved' ORDER BY kind,target_id,created_at DESC,id DESC;
