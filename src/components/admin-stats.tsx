'use client';

import { useEffect, useState } from 'react';
import { Activity, RefreshCw, UserPlus, Users } from 'lucide-react';
import styles from './admin-stats.module.css';

type Stats = import('../shared/admin-stats').AdminStatsSnapshot;

function isStats(value: unknown): value is Stats {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return ['totalUsers', 'onlineUsers', 'activeToday', 'newToday'].every(key =>
    typeof data[key] === 'number' && Number.isSafeInteger(data[key]) && data[key] >= 0
  ) && data.onlineWindowMinutes === 5 && data.timeZone === 'Asia/Shanghai'
    && typeof data.asOf === 'string' && Number.isFinite(Date.parse(data.asOf));
}

export function AdminStats({ revision }: { revision: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      if (!live || stopped || document.hidden || controller) return;
      if (timer) clearTimeout(timer);
      const current = new AbortController();
      controller = current;
      let timedOut = false;
      timeout = setTimeout(() => { timedOut = true; current.abort(); }, 15000);
      setRefreshing(true);
      try {
        const response = await fetch('/api/v1/admin/stats', { cache: 'no-store', signal: current.signal });
        if (!live || current.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          stopped = true;
          setStats(null);
          throw new Error(response.status === 401 ? '登录已过期，请重新登录后查看。' : '当前账号没有查看统计的权限。');
        }
        if (!response.ok) throw new Error('统计暂时无法更新，请稍后重试。');
        const result: unknown = await response.json();
        if (!isStats(result)) throw new Error('统计数据读取失败，请稍后重试。');
        if (live && !current.signal.aborted) {
          setStats(result);
          setError('');
        }
      } catch (failure) {
        if (live && (!current.signal.aborted || timedOut)) {
          setError(timedOut ? '统计更新超时，请稍后重试。' : failure instanceof Error && failure.name !== 'TypeError' ? failure.message : '网络连接失败，请稍后重试。');
        }
      } finally {
        if (controller === current) {
          if (timeout) clearTimeout(timeout);
          controller = null;
          if (live) {
            setRefreshing(false);
            if (!stopped && !document.hidden) timer = setTimeout(load, 30000);
          }
        }
      }
    }

    function visibilityChanged() {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        if (timeout) clearTimeout(timeout);
        controller?.abort();
        controller = null;
        setRefreshing(false);
      } else void load();
    }

    void load();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (timeout) clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [revision, version]);

  const cards = [
    { key: 'totalUsers', title: '总用户数', detail: '已注册成员', icon: Users },
    { key: 'onlineUsers', title: '当前在线', detail: '最近 5 分钟', icon: Activity },
    { key: 'activeToday', title: '今日活跃', detail: '今日访问的成员', icon: Users },
    { key: 'newToday', title: '今日新增', detail: '今日注册的成员', icon: UserPlus },
  ] as const;

  return <section className={styles.section} aria-labelledby="admin-stats-title">
    <div className={styles.heading}>
      <div><h2 id="admin-stats-title">社群概况</h2><p>看看有多少成员加入、正在参与。</p></div>
      <button type="button" className={styles.refresh} onClick={() => setVersion(value => value + 1)} disabled={refreshing} aria-label="刷新社群统计"><RefreshCw size={15} aria-hidden="true"/>{refreshing ? '更新中' : '刷新'}</button>
    </div>
    <dl className={styles.cards} aria-busy={refreshing}>
      {cards.map(({ key, title, detail, icon: Icon }) => <div key={key} className={`${styles.card} ${key === 'onlineUsers' ? styles.online : ''}`}>
        <dt><Icon size={16} aria-hidden="true"/>{title}</dt>
        <dd>{stats ? stats[key].toLocaleString('zh-CN') : <span className={styles.placeholder} aria-label={error ? '数据不可用' : '正在加载'}>—</span>}</dd>
        <dd className={styles.detail}>{detail}</dd>
      </div>)}
    </dl>
    {error && <p className={styles.error} role="alert">{error}{stats ? ' 当前显示上次成功更新的数据，可能已过时。' : ''}</p>}
    <p className={styles.definition}>当前在线为最近 {stats?.onlineWindowMinutes ?? 5} 分钟在前台访问的已登录成员。在线与活跃人数不含访客、Agent 和封禁账号，同一成员只计一次。</p>
    <div className={styles.footer}>
      <span>今日按北京时间统计 · 页面可见时每 30 秒更新</span>
      <span role="status">{stats ? <>更新于 <time dateTime={stats.asOf}>{new Date(stats.asOf).toLocaleString('zh-CN', { timeZone: stats.timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time></> : refreshing ? '正在读取统计…' : error ? '尚无可用统计' : '等待更新'}</span>
    </div>
  </section>;
}
