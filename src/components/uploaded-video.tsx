'use client';

import { useState } from 'react';
import { isVideoMime } from '@/shared/video';
import styles from './uploaded-video.module.css';

type Props = { src: string; mime: string; label?: string };

export function UploadedVideo(props: Props) {
  if (!isVideoMime(props.mime)) return null;
  return <VideoPlayer key={props.src} {...props}/>;
}

function VideoPlayer({ src, label = '帖子视频' }: Props) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <div className={styles.player}>
    <video key={attempt} className={styles.video} src={src} controls playsInline preload="metadata" aria-label={label} onError={() => setFailed(true)}>
      你的浏览器不支持视频播放，请打开视频文件查看。
    </video>
    {failed && <p className={styles.error} role="status">暂时无法播放。浏览器可能不支持该视频编码，或文件暂时不可用。</p>}
    <div className={styles.actions}>
      <a href={src} target="_blank" rel="noopener noreferrer">打开视频文件</a>
      {failed && <button type="button" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>重试播放</button>}
    </div>
  </div>;
}
