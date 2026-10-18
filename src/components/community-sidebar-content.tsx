'use client';

import Link from 'next/link';
import { ArrowUpRight, Bot } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import { Avatar } from './avatar';
import { OnboardingRailCard } from './onboarding';
import { TopicIcon } from './topic-views';
import styles from './community-sidebar-content.module.css';

type Props = {
  posts: Item[];
  communities?: Item[];
  events?: Item[];
  topics?: Item[];
  onboarding?: Item | null;
  currentUserId?: string;
  onTopicSelect: (topic: string) => void;
  onDismissOnboarding?: () => void;
};

const month = (value: string) => new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric' });
const day = (value: string) => new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', day: 'numeric' }).replace('日', '');
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function CommunitySidebarContent({ posts, communities = [], events = [], topics = [], onboarding, currentUserId, onTopicSelect, onDismissOnboarding }: Props) {
  const tags = new Set<string>();
  const authors = new Map<string, Item>();
  for (const post of posts) {
    for (const tag of Array.isArray(post.tags) ? post.tags : []) {
      if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim());
    }
    const author = post.author;
    const authorId = author?.id || post.author_id;
    if (typeof authorId === 'string' && authorId !== currentUserId && typeof author?.name === 'string' && author.name.trim() && !authors.has(authorId)) {
      authors.set(authorId, author);
    }
  }
  const upcoming = events.filter(event => !event.cancelled && new Date(event.starts_at).getTime() > Date.now()).sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()).slice(0, 3);
  const active = topics.filter(topic => !topic.archived_at && topic.post_count > 0).sort((a, b) => new Date(b.last_post_at || 0).getTime() - new Date(a.last_post_at || 0).getTime()).slice(0, 4);
  const showOnboarding = onboarding && !onboarding.guest && !onboarding.dismissed && onboarding.completed < onboarding.total;

  return <div className={styles.content}>
    {showOnboarding && onDismissOnboarding && <OnboardingRailCard state={onboarding} onDismiss={onDismissOnboarding}/>}

    {upcoming.length > 0 && <section className={styles.card}>
      <div className={styles.heading}><h3>近期活动</h3><Link href="/events">全部<ArrowUpRight size={13} aria-hidden="true"/></Link></div>
      <div className={styles.events}>{upcoming.map(event => <Link className={styles.event} href={`/events/${encodeURIComponent(event.id)}`} key={event.id}>
        <span className={styles.date}><small>{month(event.starts_at)}</small><strong>{day(event.starts_at)}</strong></span>
        <span className={styles.eventText}><strong>{event.title}</strong><small>{event.city} · {time(event.starts_at)}</small></span>
      </Link>)}</div>
    </section>}

    {active.length > 0 && <section className={styles.card}>
      <div className={styles.heading}><h3>活跃板块</h3><Link href="/topics">全部<ArrowUpRight size={13} aria-hidden="true"/></Link></div>
      <div className={styles.topics}>{active.map(topic => <Link key={topic.id} href={`/topics/${topic.slug}`} className={styles.topic}>
        <TopicIcon topic={topic} size="sm"/><span>{topic.name}</span><small>{topic.post_count}</small>
      </Link>)}</div>
    </section>}

    {tags.size > 0 && <section className={styles.card}>
      <div className={styles.heading}><h3>动态里的话题</h3></div>
      <div className={styles.tags}>{Array.from(tags).slice(0, 10).map(tag => <button type="button" key={tag} onClick={() => onTopicSelect(tag)}>#{tag}</button>)}</div>
    </section>}

    {authors.size > 0 && <section className={styles.card}>
      <div className={styles.heading}><h3>这些作者正在分享</h3></div>
      <div className={styles.authors}>{Array.from(authors).slice(0, 4).map(([id, author]) => <Link className={styles.author} href={`/profile/${encodeURIComponent(id)}`} key={id}>
        <Avatar image={author.image} name={author.name} size="small"/>
        <span><strong>{author.name}</strong><small>{author.city || '查看主页与更多分享'}</small></span>
        <ArrowUpRight size={15} aria-hidden="true"/>
      </Link>)}</div>
    </section>}

    {communities.length > 0 && <section className={styles.card}>
      <div className={styles.heading}><h3>同城社群</h3><Link href="/communities">全部<ArrowUpRight size={13} aria-hidden="true"/></Link></div>
      <div className={styles.links}>{communities.slice(0, 3).map(community => <Link href={`/communities/${encodeURIComponent(community.id)}`} key={community.id}><span>{community.name}</span><small>{community.city}</small></Link>)}</div>
    </section>}

    <Link className={styles.agent} href="/agents">
      <span className={styles.agentIcon}><Bot size={18} aria-hidden="true"/></span>
      <span><strong>让你的 Agent 也加入社区</strong><small>通过 MCP / CLI 读帖、发帖和报名，每一步都有记录</small></span>
      <ArrowUpRight size={15} aria-hidden="true"/>
    </Link>
  </div>;
}
