'use client';

import { parsingJobLabel } from '@/shared/parsing-progress';
import styles from './post-processing.module.css';

type Job = { id: string; kind: string; target_id?: string; status: string; attempts?: number };
type Media = { id: string; mime: string };
type Props = { jobs: Job[]; media: Media[]; busy: boolean; onRetry: (jobId: string) => void };

export function PostProcessing({ jobs, media, busy, onRetry }: Props) {
  const images = media.filter(item => item.mime.startsWith('image/'));
  const imageJobs = jobs.filter(job => job.kind === 'image').map(job => ({
    job, index: images.findIndex(image => image.id === job.target_id),
  })).sort((a, b) => (a.index < 0 ? Infinity : a.index) - (b.index < 0 ? Infinity : b.index));
  const linkJobs = jobs.filter(job => job.kind === 'link');
  if (!imageJobs.length && !linkJobs.length) return null;

  function row(job: Job, label: string, image = false) {
    const retryable = job.status === 'failed' || job.status === 'blocked';
    const status = image && job.status === 'failed' ? '辅助解析未完成'
      : image && job.status === 'blocked' ? '辅助解析暂不可用' : parsingJobLabel(job);
    return <div className={styles.row} key={job.id}>
      <span>{label}：{status}</span>
      {retryable && <button type="button" className="text-button" disabled={busy} aria-label={`重试${label}`} onClick={() => onRetry(job.id)}>重试</button>}
    </div>;
  }

  return <div className="processing-status">
    {!!imageJobs.length && <details className={styles.images}>
      <summary>图片辅助解析（可选）· {imageJobs.length} 项</summary>
      <p className={styles.help}>这是可选的 AI 文字提取和描述，不影响已展示的原图。</p>
      <div className={styles.rows}>{imageJobs.map(({ job, index }) => row(job, index < 0 ? '未展示的图片' : `图片 ${index + 1}`, true))}</div>
    </details>}
    {!!linkJobs.length && <div className={styles.links}>{linkJobs.map(job => row(job, '链接解析'))}</div>}
  </div>;
}
