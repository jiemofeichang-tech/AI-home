'use client';

import { useId, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronUp, Play } from 'lucide-react';
import { douyinPlayerUrl, getDouyinEmbed } from '@/shared/douyin';
import styles from './douyin-embed.module.css';

type Props = {
  metadata: unknown;
  url: string;
  title?: string;
  description?: string;
  children: ReactNode;
};

export function DouyinEmbed({ metadata, children, ...props }: Props) {
  const embed = getDouyinEmbed(metadata);
  const src = embed && douyinPlayerUrl(embed.videoId);
  if (!embed || !src) return <>{children}</>;
  return <DouyinPlayer key={embed.videoId} {...props} embed={embed} src={src}/>;
}

function DouyinPlayer({ url, title, description, embed, src }: Omit<Props, 'metadata' | 'children'> & {
  embed: { videoId: string; width: number; height: number };
  src: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const playerId = useId();
  return <section className={styles.card} aria-label="抖音视频">
    <div className={styles.heading}>
      <span className={styles.source}>抖音 · 视频</span>
      <strong>{title || '抖音视频'}</strong>
      {description && <p className={styles.description}>{description}</p>}
    </div>
    <div className={styles.actions}>
      <button type="button" className={styles.play} aria-expanded={expanded} aria-controls={playerId} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronUp size={16} aria-hidden="true"/> : <Play size={16} aria-hidden="true"/>}
        {expanded ? '收起视频' : '播放抖音视频'}
      </button>
      <a className={styles.original} href={url} target="_blank" rel="noopener noreferrer">在抖音打开<ArrowUpRight size={15} aria-hidden="true"/></a>
    </div>
    <div id={playerId} hidden={!expanded}>
      {expanded && <div className={styles.frame} style={{ aspectRatio: `${embed.width} / ${embed.height}`, maxWidth: 520 * embed.width / embed.height }}>
        <iframe src={src} title={title ? `抖音视频：${title}` : '抖音视频播放器'} allow="fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"/>
      </div>}
    </div>
    <p className={styles.hint}>{expanded ? '如视频受限或无法播放，可在抖音打开。' : '点击后加载抖音播放器。'}</p>
  </section>;
}
