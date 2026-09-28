CREATE TABLE IF NOT EXISTS profiles (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  handle text UNIQUE NOT NULL, bio text NOT NULL DEFAULT '', city text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')), banned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS communities (
  id text PRIMARY KEY, name text NOT NULL, description text NOT NULL DEFAULT '', city text NOT NULL DEFAULT '',
  visibility text NOT NULL CHECK(visibility IN ('public','private')), owner_id text NOT NULL REFERENCES "user"(id),
  announcement text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  community_id text REFERENCES communities(id) ON DELETE CASCADE, user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')), status text NOT NULL CHECK(status IN ('pending','active')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(community_id,user_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id text PRIMARY KEY, author_id text NOT NULL REFERENCES "user"(id), community_id text REFERENCES communities(id),
  body text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}', original_id text REFERENCES posts(id),
  agent_name text, idempotency_key text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(author_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS posts_feed ON posts(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS posts_community ON posts(community_id,created_at DESC);
CREATE INDEX IF NOT EXISTS posts_original ON posts(original_id);
CREATE TABLE IF NOT EXISTS media (
  id text PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), post_id text REFERENCES posts(id),
  storage_key text UNIQUE NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, original_name text NOT NULL,
  extracted_text text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending',
  error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS link_resources (
  id text PRIMARY KEY, post_id text NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  url text NOT NULL, platform text NOT NULL, title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '', metadata jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending',
  error text, fetched_at timestamptz, UNIQUE(post_id,url)
);
CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY, post_id text NOT NULL REFERENCES posts(id), author_id text NOT NULL REFERENCES "user"(id),
  body text NOT NULL, agent_name text, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reactions (
  post_id text REFERENCES posts(id), user_id text REFERENCES "user"(id), kind text CHECK(kind IN ('like','bookmark')),
  PRIMARY KEY(post_id,user_id,kind)
);
CREATE TABLE IF NOT EXISTS follows (
  follower_id text REFERENCES "user"(id), following_id text REFERENCES "user"(id), PRIMARY KEY(follower_id,following_id), CHECK(follower_id<>following_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id text REFERENCES "user"(id), blocked_id text REFERENCES "user"(id), PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id<>blocked_id)
);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY, community_id text NOT NULL REFERENCES communities(id), organizer_id text NOT NULL REFERENCES "user"(id),
  title text NOT NULL, description text NOT NULL DEFAULT '', city text NOT NULL, address text NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, capacity integer NOT NULL CHECK(capacity>0),
  cancelled boolean NOT NULL DEFAULT false, recap text NOT NULL DEFAULT '', agent_name text,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS registrations (
  event_id text REFERENCES events(id), user_id text REFERENCES "user"(id),
  checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,user_id)
);
CREATE TABLE IF NOT EXISTS agent_grants (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), name text NOT NULL,
  token_hash text UNIQUE, oauth_client_id text, scopes text[] NOT NULL,
  community_ids text[] NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_grants_oauth ON agent_grants(user_id,oauth_client_id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY, user_id text REFERENCES "user"(id), grant_id text REFERENCES agent_grants(id),
  action text NOT NULL, target_id text, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), text text NOT NULL, href text NOT NULL DEFAULT '/',
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reports (
  id text PRIMARY KEY, reporter_id text NOT NULL REFERENCES "user"(id), post_id text NOT NULL REFERENCES posts(id),
  reason text NOT NULL, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY, kind text NOT NULL, target_id text NOT NULL, status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, error text, available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,target_id)
);
CREATE TABLE IF NOT EXISTS usage_counters (
  key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS request_keys (
  user_id text NOT NULL, key text NOT NULL, action text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
