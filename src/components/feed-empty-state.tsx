'use client';

import Link from 'next/link';
import { Bookmark, MessageCircle, UserPlus } from 'lucide-react';
import styles from './feed-empty-state.module.css';

type Props = { feed: string; onBrowse: () => void; onCreate?: () => void };

export function FeedEmptyState({ feed, onBrowse, onCreate }: Props) {
  const following = feed === 'following';
  const bookmarks = feed === 'bookmarks';
  const Icon = following ? UserPlus : bookmarks ? Bookmark : MessageCircle;
  const title = following ? '这里还没有关注动态' : bookmarks ? '还没有收藏的内容' : '还没有动态，来聊聊你的发现';
  const detail = following
    ? '在最新动态里找到感兴趣的作者，进入主页点击“关注”，之后在这里查看他们的分享。'
    : bookmarks
      ? '浏览动态时，点击帖子下方的收藏图标。想再看时，就能在这里找到。'
      : '分享一个正在尝试的工具、一段实践经验，或一个想和大家讨论的问题。';

  return <div className={`empty ${styles.empty}`}>
    <Icon aria-hidden="true"/>
    <h3>{title}</h3>
    <p>{detail}</p>
    <div className={styles.action}>
      {following || bookmarks
        ? <button type="button" className="secondary" onClick={onBrowse}>浏览最新动态</button>
        : onCreate
          ? <button type="button" className="secondary" onClick={onCreate}>发布第一条动态</button>
          : <Link className="secondary" href="/discover">去发现内容</Link>}
    </div>
  </div>;
}
