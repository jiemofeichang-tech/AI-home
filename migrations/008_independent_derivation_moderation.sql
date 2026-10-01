-- Original text, submitted URLs and raw images can publish independently of
-- optional OCR and fetched previews. Existing approved results were checked
-- together with their original post by the preceding moderation pipeline.
ALTER TABLE media ADD COLUMN derivation_status text NOT NULL DEFAULT 'pending'
  CHECK (derivation_status IN ('pending','review','rejected','approved','deleted'));
ALTER TABLE link_resources ADD COLUMN derivation_status text NOT NULL DEFAULT 'pending'
  CHECK (derivation_status IN ('pending','review','rejected','approved','deleted'));
UPDATE media SET derivation_status='approved' WHERE moderation_status='approved';
UPDATE link_resources SET derivation_status='approved' WHERE moderation_status='approved';
ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_target_type_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_target_type_check
  CHECK (target_type IN ('post','comment','draft','media','link'));

-- Direct/older parser writes fail closed at the derived field boundary too.
CREATE OR REPLACE FUNCTION moderation_guard_derivation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; reviewer text; removed timestamptz; case_id text; author text; derived_kind text;
BEGIN
  IF current_setting('app.privacy_restore',true)='on' OR current_setting('app.moderation_write',true)='on' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='media' THEN
    derived_kind := 'media';
    changed := NEW.extracted_text IS DISTINCT FROM OLD.extracted_text OR NEW.description IS DISTINCT FROM OLD.description;
    IF NEW.ai_consent=false AND NEW.extracted_text='' AND NEW.description='' THEN
      NEW.derivation_status := 'deleted';
      UPDATE moderation_cases SET status='deleted',revision=revision+1,generation=generation+1,reason='已撤回图片解析授权。',updated_at=now()
        WHERE target_type='media' AND target_id=NEW.id RETURNING id INTO case_id;
      UPDATE jobs SET status='done',locked_at=NULL,error=NULL WHERE kind='moderation' AND target_id=case_id;
      RETURN NEW;
    END IF;
  ELSE
    derived_kind := 'link';
    changed := NEW.url IS DISTINCT FROM OLD.url OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description OR NEW.content IS DISTINCT FROM OLD.content
      OR NEW.metadata IS DISTINCT FROM OLD.metadata;
  END IF;
  IF NOT changed OR NEW.post_id IS NULL THEN RETURN NEW; END IF;
  SELECT p.deleted_at,c.reviewed_by,p.author_id INTO removed,reviewer,author FROM posts p
    LEFT JOIN moderation_cases c ON c.target_type='post' AND c.target_id=p.id WHERE p.id=NEW.post_id;
  IF removed IS NOT NULL OR reviewer IS NOT NULL OR author IS NULL THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM moderation_cases c WHERE c.target_type=derived_kind AND c.target_id=NEW.id AND (c.reviewed_by IS NOT NULL OR c.status='deleted')) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='link_resources' THEN
    -- A changed destination is a changed original submission, not a preview.
    IF NEW.url IS DISTINCT FROM OLD.url THEN
      NEW.moderation_status := 'pending';
      PERFORM moderation_invalidate_post(NEW.post_id);
    END IF;
  END IF;
  NEW.derivation_status := 'pending';
  INSERT INTO moderation_cases(id,target_type,target_id,author_id) VALUES(gen_random_uuid()::text,derived_kind,NEW.id,author)
    ON CONFLICT(target_type,target_id) DO UPDATE SET status='pending',revision=moderation_cases.revision+1,generation=moderation_cases.generation+1,labels='{}',reason='',provider='',updated_at=now()
    RETURNING id INTO case_id;
  INSERT INTO jobs(id,kind,target_id) VALUES(gen_random_uuid()::text,'moderation',case_id)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL;
  INSERT INTO jobs(id,kind,target_id) VALUES(gen_random_uuid()::text,'index',NEW.post_id)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION moderation_target_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE moderation_cases SET status='deleted',revision=revision+1,generation=generation+1,updated_at=now()
      WHERE target_type=CASE WHEN TG_TABLE_NAME='posts' THEN 'post' ELSE 'comment' END AND target_id=NEW.id;
    IF TG_TABLE_NAME='posts' THEN
      UPDATE moderation_cases SET status='deleted',revision=revision+1,generation=generation+1,updated_at=now()
        WHERE (target_type='media' AND target_id IN (SELECT id FROM media WHERE post_id=NEW.id))
           OR (target_type='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=NEW.id));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Optional results that existed but had not yet passed the old combined check
-- receive their own durable jobs. Never re-open a manual decision.
INSERT INTO moderation_cases(id,target_type,target_id,author_id)
  SELECT gen_random_uuid()::text,'media',m.id,p.author_id FROM media m JOIN posts p ON p.id=m.post_id
  JOIN moderation_cases c ON c.target_type='post' AND c.target_id=p.id
  WHERE m.ai_consent AND (m.extracted_text<>'' OR m.description<>'') AND m.derivation_status='pending' AND p.deleted_at IS NULL AND c.reviewed_by IS NULL
  UNION ALL
  SELECT gen_random_uuid()::text,'link',l.id,p.author_id FROM link_resources l JOIN posts p ON p.id=l.post_id
  JOIN moderation_cases c ON c.target_type='post' AND c.target_id=p.id
  WHERE (l.title<>'' OR l.description<>'' OR l.content<>'' OR l.metadata<>'{}'::jsonb) AND l.derivation_status='pending' AND p.deleted_at IS NULL AND c.reviewed_by IS NULL;
INSERT INTO jobs(id,kind,target_id)
  SELECT gen_random_uuid()::text,'moderation',id FROM moderation_cases WHERE target_type IN ('media','link') AND status='pending';
