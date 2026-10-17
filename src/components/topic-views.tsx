'use client';
import Link from 'next/link';
import { ArrowUpRight, Lock, PenLine } from 'lucide-react';
import { topicSections, type Item } from '@/shared/contracts';
import { ago } from '@/shared/relative-time';
import styles from './topic-views.module.css';

const fixedTints:Record<string,number>={announcements:1,introductions:4,projects:0,questions:3,resources:2,collaboration:5,cafe:6};
export function topicTint(slug='') {
  if(slug in fixedTints)return fixedTints[slug];
  let hash=0;for(const char of slug)hash=(hash*31+char.charCodeAt(0))>>>0;
  return hash%7;
}

export function TopicIcon({topic,size='md'}:{topic:Item;size?:'sm'|'md'|'lg'}) {
  return <span className={`${styles.icon} ${styles[size]} tint-${topicTint(topic.slug)}`} aria-hidden="true">{topic.icon||'💬'}</span>;
}

function activity(topic:Item) {
  return `${topic.post_count||0} 条帖子${topic.last_post_at?` · ${ago(topic.last_post_at)}更新`:''}`;
}

export function groupTopics(topics:Item[]) {
  return (Object.keys(topicSections) as (keyof typeof topicSections)[])
    .map(key=>({key,label:topicSections[key],items:topics.filter(topic=>topic.section===key&&!topic.archived_at)}))
    .filter(group=>group.items.length);
}

export function TopicDirectory({topics,compact=false}:{topics:Item[];compact?:boolean}) {
  return <div className={styles.directory}>{groupTopics(topics).map(group=><section key={group.key}>
    <h3 className={styles.groupLabel}>{group.label}</h3>
    <div className={compact?styles.compactGrid:styles.grid}>{group.items.map(topic=><Link key={topic.id} href={`/topics/${topic.slug}`} className={styles.card}>
      <TopicIcon topic={topic}/>
      <div className={styles.cardText}>
        <strong>{topic.name}{topic.posting==='admins'&&<Lock size={12} aria-label="仅管理员发布"/>}</strong>
        {!compact&&topic.description&&<p>{topic.description}</p>}
        <span>{activity(topic)}</span>
      </div>
      <ArrowUpRight size={16} aria-hidden="true"/>
    </Link>)}</div>
  </section>)}</div>;
}

export function TopicHero({topic,onCompose}:{topic:Item;onCompose:()=>void}) {
  return <section className={`card ${styles.hero} tint-${topicTint(topic.slug)}`}>
    <div className={styles.band} aria-hidden="true"/>
    <div className={styles.heroBody}>
      <TopicIcon topic={topic} size="lg"/>
      <div className={styles.heroText}>
        <span className="eyebrow">{topicSections[topic.section as keyof typeof topicSections]||'社区板块'}</span>
        <h2>{topic.name}</h2>
        {topic.description&&<p>{topic.description}</p>}
        <span className={styles.heroMeta}>{activity(topic)}</span>
      </div>
      <div className={styles.heroAction}>
        {topic.canPost
          ?<button type="button" className="primary" onClick={onCompose}><PenLine size={16}/>发布到{topic.name}</button>
          :topic.posting==='admins'?<span className="pill"><Lock size={12}/>仅管理员发布</span>:null}
      </div>
    </div>
  </section>;
}

export function TopicPicker({topics,value,onChange,isAdmin,disabled}:{topics:Item[];value:string;onChange:(id:string)=>void;isAdmin:boolean;disabled?:boolean}) {
  const options=topics.filter(topic=>!topic.archived_at&&(topic.posting!=='admins'||isAdmin));
  return <div className={styles.picker} role="radiogroup" aria-label="选择板块">
    <button type="button" role="radio" aria-checked={!value} disabled={disabled} className={!value?styles.selected:''} onClick={()=>onChange('')}>不选板块</button>
    {options.map(topic=><button type="button" role="radio" aria-checked={value===topic.id} disabled={disabled} key={topic.id} className={value===topic.id?styles.selected:''} onClick={()=>onChange(topic.id)}>
      <span aria-hidden="true">{topic.icon}</span>{topic.name}
    </button>)}
  </div>;
}

export function TopicStrip({topics,active}:{topics:Item[];active?:string}) {
  const items=topics.filter(topic=>!topic.archived_at);
  if(!items.length)return null;
  return <nav className={styles.strip} aria-label="社区板块">
    <Link href="/topics" className={!active?styles.stripActive:''}>全部板块</Link>
    {items.map(topic=><Link key={topic.id} href={`/topics/${topic.slug}`} className={active===topic.id?styles.stripActive:''}><span aria-hidden="true">{topic.icon}</span>{topic.name}</Link>)}
  </nav>;
}
