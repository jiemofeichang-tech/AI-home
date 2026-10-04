-- Preserve an author's chosen order independently of upload or processing time.
-- NULL keeps existing media and older application versions compatible: readers
-- fall back to created_at,id until an explicit order is saved for a new post.
ALTER TABLE media ADD COLUMN position integer CHECK (position BETWEEN 0 AND 8);
CREATE UNIQUE INDEX media_post_position ON media(post_id,position)
  WHERE post_id IS NOT NULL AND position IS NOT NULL;
