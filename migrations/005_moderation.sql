-- Preserve previously published data. Only content created after this migration
-- starts in quarantine; the legacy marker is not a fresh provider approval.
ALTER TABLE posts ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
  CHECK (moderation_status IN ('pending','review','rejected','approved','deleted'));
ALTER TABLE comments ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
  CHECK (moderation_status IN ('pending','review','rejected','approved','deleted'));
ALTER TABLE media ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
  CHECK (moderation_status IN ('pending','review','rejected','approved','deleted'));
ALTER TABLE link_resources ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved'
  CHECK (moderation_status IN ('pending','review','rejected','approved','deleted'));
ALTER TABLE posts ALTER COLUMN moderation_status SET DEFAULT 'pending';
ALTER TABLE comments ALTER COLUMN moderation_status SET DEFAULT 'pending';
ALTER TABLE media ALTER COLUMN moderation_status SET DEFAULT 'pending';
ALTER TABLE link_resources ALTER COLUMN moderation_status SET DEFAULT 'pending';

CREATE TABLE moderation_cases (
  id text PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('post','comment','draft')),
  target_id text NOT NULL,
  author_id text NOT NULL REFERENCES "user"(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','review','rejected','approved','deleted')),
  labels text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL DEFAULT '',
  appeal_reason text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  reviewed_by text REFERENCES "user"(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  generation integer NOT NULL DEFAULT 1 CHECK (generation>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(target_type,target_id)
);
CREATE INDEX moderation_cases_queue ON moderation_cases(status,created_at);
CREATE INDEX moderation_cases_author ON moderation_cases(author_id,created_at DESC);
CREATE TABLE moderation_history (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  actor_id text REFERENCES "user"(id) ON DELETE SET NULL,
  action text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','review','rejected','approved','deleted')),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_history_case ON moderation_history(case_id,created_at DESC);
INSERT INTO moderation_cases(id,target_type,target_id,author_id,status,labels,provider)
  SELECT gen_random_uuid()::text,'post',id,author_id,CASE WHEN deleted_at IS NULL THEN 'approved' ELSE 'deleted' END,ARRAY['legacy'],'legacy' FROM posts;
INSERT INTO moderation_cases(id,target_type,target_id,author_id,status,labels,provider)
  SELECT gen_random_uuid()::text,'comment',id,author_id,CASE WHEN deleted_at IS NULL THEN 'approved' ELSE 'deleted' END,ARRAY['legacy'],'legacy' FROM comments;
UPDATE posts SET moderation_status='deleted' WHERE deleted_at IS NOT NULL;
UPDATE comments SET moderation_status='deleted' WHERE deleted_at IS NOT NULL;

-- Defensive quarantine for an older worker still writing after deployment.
-- Controlled current workers use a revision CAS and this transaction-local flag.
CREATE FUNCTION moderation_invalidate_post(post_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE case_id text;
BEGIN
  UPDATE posts SET moderation_status='pending' WHERE id=post_id AND deleted_at IS NULL;
  UPDATE moderation_cases SET status='pending',revision=revision+1,labels='{}',reason='',provider='',updated_at=now()
    WHERE target_type='post' AND target_id=post_id AND reviewed_by IS NULL AND status<>'deleted' RETURNING id INTO case_id;
  IF case_id IS NOT NULL THEN
    INSERT INTO jobs(id,kind,target_id) VALUES(gen_random_uuid()::text,'moderation',case_id)
      ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL;
  END IF;
END;
$$;
CREATE FUNCTION moderation_guard_derivation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; reviewer text; removed timestamptz;
BEGIN
  IF current_setting('app.privacy_restore',true)='on' OR current_setting('app.moderation_write',true)='on' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='media' THEN
    changed := NEW.extracted_text IS DISTINCT FROM OLD.extracted_text OR NEW.description IS DISTINCT FROM OLD.description;
    -- Withdrawal of optional AI processing is an erasure, not new content.
    IF NEW.ai_consent=false AND NEW.extracted_text='' AND NEW.description='' THEN RETURN NEW; END IF;
  ELSE
    changed := NEW.url IS DISTINCT FROM OLD.url OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description OR NEW.content IS DISTINCT FROM OLD.content
      OR NEW.metadata IS DISTINCT FROM OLD.metadata;
  END IF;
  IF NOT changed OR NEW.post_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.deleted_at,c.reviewed_by INTO removed,reviewer FROM posts p
    LEFT JOIN moderation_cases c ON c.target_type='post' AND c.target_id=p.id WHERE p.id=NEW.post_id;
  IF removed IS NOT NULL OR reviewer IS NOT NULL THEN RETURN OLD; END IF;
  NEW.moderation_status := 'pending';
  PERFORM moderation_invalidate_post(NEW.post_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_derivation BEFORE UPDATE ON media FOR EACH ROW EXECUTE FUNCTION moderation_guard_derivation();
CREATE TRIGGER moderation_derivation BEFORE UPDATE ON link_resources FOR EACH ROW EXECUTE FUNCTION moderation_guard_derivation();

CREATE FUNCTION moderation_target_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE moderation_cases SET status='deleted',revision=revision+1,generation=generation+1,updated_at=now()
      WHERE target_type=CASE WHEN TG_TABLE_NAME='posts' THEN 'post' ELSE 'comment' END AND target_id=NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_deleted AFTER UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION moderation_target_deleted();
CREATE TRIGGER moderation_deleted AFTER UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION moderation_target_deleted();

CREATE FUNCTION moderation_closed_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE moderation_cases SET status='deleted',labels='{}',reason='',appeal_reason='',provider='',reviewed_by=NULL,
      revision=revision+1,generation=generation+1,updated_at=now() WHERE author_id=NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER moderation_account_closed AFTER UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION moderation_closed_account();
