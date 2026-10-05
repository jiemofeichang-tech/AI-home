'use client';

import Link from 'next/link';
import { ArrowUpRight, Bot } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import { Avatar } from './avatar';
import styles from './community-sidebar-content.module.css';

type Props = {
  posts: Item[];
  communities?: Item[];
  events?: Item[];
  currentUserId?: string;
  onTopicSelect: (topic: string) => void;
};

export function CommunitySidebarContent({ posts, communities = [], events = [], currentUserId, onTopicSelect }: Props) {
  const topics = new Set<string>();
  const authors = new Map<string, Item>();
  for (const post of posts) {
    for (const tag of Array.isArray(post.tags) ? post.tags : []) {
      if (typeof tag === 'string' && tag.trim()) topics.add(tag.trim());
    }
    const author = post.author;
    const authorId = author?.id || post.author_id;
    if (typeof authorId === 'string' && authorId !== currentUserId && typeof author?.name === 'string' && author.name.trim() && !authors.has(authorId)) {
      authors.set(authorId, author);
    }
  }
  const upcoming = events.filter(event => !event.cancelled && new Date(event.starts_at).getTime() > Date.now()).slice(0, 2);

  return <div className={styles.content}>
    {topics.size > 0 && <section className={styles.section}>
      <h3>动态里的话题</h3>
      <p className={styles.caption}>来自当前可见的帖子</p>
      <div className={styles.topics}>{Array.from(topics).slice(0, 8).map(topic => <button type="button" key={topic} onClick={() => onTopicSelect(topic)}>#{topic}</button>)}</div>
    </section>}

    {authors.size > 0 && <section className={styles.section}>
      <h3>这些作者正在分享</h3>
      <div className={styles.authors}>{Array.from(authors).slice(0, 4).map(([id, author]) => <Link className={styles.author} href={`/profile/${encodeURIComponent(id)}`} key={id}>
        <Avatar image={author.image} name={author.name} size="small"/>
        <span><strong>{author.name}</strong><small>查看主页与更多分享</small></span>
        <ArrowUpRight size={15} aria-hidden="true"/>
      </Link>)}</div>
    </section>}

    {communities.length > 0 && <section className={`${styles.section} ${styles.secondary}`}>
      <div className={styles.heading}><h3>社群交流</h3><Link href="/communities">全部社群<ArrowUpRight size={13} aria-hidden="true"/></Link></div>
      <div className={styles.links}>{communities.slice(0, 3).map(community => <Link href={`/communities/${encodeURIComponent(community.id)}`} key={community.id}>{community.name}</Link>)}</div>
    </section>}

    {upcoming.length > 0 && <section className={`${styles.section} ${styles.secondary}`}>
      <div className={styles.heading}><h3>近期活动</h3><Link href="/events">全部活动<ArrowUpRight size={13} aria-hidden="true"/></Link></div>
      <div className={styles.links}>{upcoming.map(event => <Link className={styles.event} href={`/events/${encodeURIComponent(event.id)}`} key={event.id}>
        <span>{event.title}</span><time dateTime={event.starts_at}>{new Date(event.starts_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' })}</time>
      </Link>)}</div>
    </section>}

    <Link className={styles.agent} href="/agents"><Bot size={15} aria-hidden="true"/><span>使用 Agent 或 MCP 参与社区</span><ArrowUpRight size={13} aria-hidden="true"/></Link>
  </div>;
}
