'use client';
import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import { ArrowUpRight, Bell, Bot, CalendarDays, ChevronRight, Compass, Home, LayoutGrid, Lock, LogOut, Plus, Settings, ShieldCheck, Sparkles, Users } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import { Avatar } from './avatar';
import { groupTopics, TopicIcon } from './topic-views';
import styles from './app-sidebar.module.css';

type Props={section:string;id?:string;me:Item|null;topics:Item[];communities:Item[];events:Item[];onboarding:Item|null;onCompose:()=>void;onLogout:()=>void};

function NavLink({href,icon:Icon,label,active,badge}:{href:string;icon:ComponentType<{size?:number}>;label:string;active:boolean;badge?:ReactNode}) {
  return <Link href={href} className={`${styles.item} ${active?styles.active:''}`} aria-current={active?'page':undefined}><Icon size={18}/><span>{label}</span>{badge}</Link>;
}

export function AppSidebar({section,id,me,topics,communities,events,onboarding,onCompose,onLogout}:Props) {
  const joined=communities.filter(community=>community.membership_status==='active').slice(0,4);
  const upcoming=events.filter(event=>!event.cancelled&&new Date(event.starts_at).getTime()>Date.now()).length;
  const progress=onboarding&&!onboarding.guest&&!onboarding.dismissed&&onboarding.completed<onboarding.total?<span className={styles.badge}>{onboarding.completed}/{onboarding.total}</span>:null;
  return <aside className="sidebar">
    <div className={styles.scroll}>
      <Link href="/" className={styles.brand}><span className="brand-mark">ai<span>+</span></span><strong>AI 社区</strong><span className="beta">BETA</span></Link>
      <nav className={styles.nav} aria-label="主导航">
        <NavLink href="/" icon={Home} label="社区动态" active={section==='home'}/>
        <NavLink href="/discover" icon={Compass} label="发现" active={section==='discover'}/>
        <NavLink href="/start" icon={Sparkles} label="从这里开始" active={section==='start'} badge={progress}/>
        {me&&<NavLink href="/notifications" icon={Bell} label="消息" active={section==='notifications'}/>}
      </nav>

      {topics.length>0&&<details className={styles.group} open>
        <summary>板块<Link href="/topics" aria-label="全部板块" className={styles.groupLink}><LayoutGrid size={14}/></Link></summary>
        {groupTopics(topics).map(group=><div key={group.key} className={styles.subgroup}>
          <span className={styles.subLabel}>{group.label}</span>
          {group.items.map(topic=><Link key={topic.id} href={`/topics/${topic.slug}`} className={`${styles.item} ${styles.topic} ${section==='topics'&&(id===topic.slug||id===topic.id)?styles.active:''}`}>
            <TopicIcon topic={topic} size="sm"/><span>{topic.name}</span>{topic.posting==='admins'&&<Lock size={12} className={styles.muted} aria-label="仅管理员发布"/>}
          </Link>)}
        </div>)}
      </details>}

      <details className={styles.group} open>
        <summary>同城</summary>
        <NavLink href="/communities" icon={Users} label="同城社群" active={section==='communities'&&!id} badge={communities.length?<span className={styles.count}>{communities.length}</span>:null}/>
        <NavLink href="/events" icon={CalendarDays} label="线下活动" active={section==='events'} badge={upcoming?<span className={styles.count}>{upcoming}</span>:null}/>
        {joined.map(community=><Link key={community.id} href={`/communities/${encodeURIComponent(community.id)}`} className={`${styles.item} ${styles.community} ${section==='communities'&&id===community.id?styles.active:''}`}>
          <span className={styles.dot} aria-hidden="true">{community.name.slice(0,1)}</span><span>{community.name}</span>{community.visibility==='private'&&<Lock size={12} className={styles.muted} aria-label="私密社群"/>}
        </Link>)}
      </details>

      {me&&<details className={styles.group} open>
        <summary>我的</summary>
        <NavLink href="/moderation" icon={ShieldCheck} label="我的发布" active={section==='moderation'}/>
        <NavLink href="/agents" icon={Bot} label="我的 Agent" active={section==='agents'}/>
        {me.role==='admin'&&<NavLink href="/admin" icon={Settings} label="社区管理" active={section==='admin'}/>}
      </details>}
    </div>

    <div className={styles.footer}>
      <button type="button" className={`primary full ${styles.compose}`} onClick={onCompose}><Plus size={18}/>发布动态</button>
      {me?<div className={styles.account}>
        <Link href={`/profile/${me.id}`} className={styles.accountLink}><Avatar image={me.image} name={me.name} size="small"/><span><strong>{me.name}</strong><small>@{me.handle}</small></span><ChevronRight size={15}/></Link>
        <div className={styles.accountTools}><Link href="/settings"><Settings size={14}/>设置</Link><button type="button" onClick={onLogout}><LogOut size={14}/>退出</button></div>
      </div>:<Link className="secondary full" href="/login">登录 / 加入社区<ArrowUpRight size={16}/></Link>}
    </div>
  </aside>;
}
