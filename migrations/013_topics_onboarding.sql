-- Site-wide topic boards. Board posts are public posts; community posts keep
-- their own membership rules and never carry a board.
CREATE TABLE IF NOT EXISTS topics (
  id text PRIMARY KEY,
  slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  icon text NOT NULL DEFAULT '💬' CHECK (char_length(icon) BETWEEN 1 AND 8),
  section text NOT NULL DEFAULT 'share' CHECK (section IN ('start','share','connect')),
  position integer NOT NULL DEFAULT 100,
  posting text NOT NULL DEFAULT 'members' CHECK (posting IN ('members','admins')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE posts ADD COLUMN IF NOT EXISTS topic_id text REFERENCES topics(id);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS posts_topic ON posts(topic_id,created_at DESC) WHERE deleted_at IS NULL;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS onboarding_dismissed_at timestamptz;

INSERT INTO topics(id,slug,name,description,icon,section,position,posting) VALUES
  ('announcements','announcements','社区公告','运营团队发布的重要通知、活动预告和规则更新。','📣','start',10,'admins'),
  ('introductions','introductions','自我介绍','新朋友报到处：你是谁、在哪座城市、最近在用 AI 做什么。','👋','start',20,'members'),
  ('projects','projects','项目展示','把正在做的东西带进来：第一版、实验、上线的产品或一次复盘，都值得被看见。','🚀','share',30,'members'),
  ('questions','questions','求助问答','卡住了就来问：说清背景、尝试过的方法和报错，更容易得到好答案。','💡','share',40,'members'),
  ('resources','resources','工具与资源','好用的 AI 工具、开源项目、教程和工作流，附上你的真实使用体验。','🧰','share',50,'members'),
  ('collaboration','collaboration','招聘与合作','招人、找队友、寻求合作或对接资源，请写清楚需求和联系方式。','🤝','connect',60,'members'),
  ('cafe','cafe','咖啡馆','轻松聊聊：行业见闻、生活日常和一闪而过的灵感。','☕','connect',70,'members')
ON CONFLICT (id) DO NOTHING;
