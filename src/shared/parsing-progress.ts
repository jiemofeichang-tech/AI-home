type ParsingJob = { kind?: string; target_id?: string; status?: string; attempts?: number };
type LinkPreview = { id?: string; status?: string; title?: string; description?: string; metadata?: Record<string, unknown> };
type Post = { author_id?: string; processing?: ParsingJob[]; original?: Post };
type Page = { items?: Post[]; posts?: Post[]; post?: Post };

export function shouldClearPageOnError(status: unknown): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function parsingJobLabel(job: ParsingJob): string {
  if (job.status === 'pending') {
    const attempts = Number.isSafeInteger(job.attempts) && job.attempts! > 0 ? job.attempts! : 0;
    return attempts ? `等待自动重试（已尝试 ${attempts} 次）` : '排队中';
  }
  if (job.status === 'processing') return '处理中';
  if (job.status === 'failed') return job.kind === 'link' ? '解析失败，可打开原链接或重试' : '处理失败，可重试';
  if (job.status === 'blocked') return job.kind === 'link' ? '解析暂不可用，可打开原链接或重试' : '处理暂不可用，可重试';
  return '已处理';
}

export function linkPreviewLabel(link: LinkPreview, jobs: ParsingJob[] = []): string {
  const job = link.id ? jobs.find(item => item.kind === 'link' && item.target_id === link.id) : undefined;
  if (job && ['pending', 'processing', 'failed', 'blocked'].includes(job.status || '')) return parsingJobLabel(job);
  // A resource can remain pending after its job is retired. Only live jobs
  // may claim that work is still queued; never reopen one from the browser.
  if (link.title || link.description || Object.keys(link.metadata || {}).length) return '已保存链接预览';
  return '暂未获取详情，可打开原链接';
}

export function shouldPollParsing({ page, userId, visible, inFlight }: {
  page: Page; userId?: string; visible: boolean; inFlight: boolean;
}): boolean {
  if (!userId || !visible || inFlight) return false;
  const posts = [...(page.items || []), ...(page.posts || []), ...(page.post ? [page.post] : [])];
  function hasWork(post: Post, depth = 0): boolean {
    if (post.author_id === userId && post.processing?.some(job =>
      (job.kind === 'link' || job.kind === 'image') && (job.status === 'pending' || job.status === 'processing'))) return true;
    return !!post.original && depth < 8 && hasWork(post.original, depth + 1);
  }
  return posts.some(post => hasWork(post));
}
