'use client';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { ArrowRight, ArrowUpRight, Bot, Check, Clock, Heart, PenLine, ShieldCheck, Sparkles, UserRound, Users, X } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import { TopicDirectory } from './topic-views';
import styles from './onboarding.module.css';

export type Draft={topicId?:string;title?:string;body?:string};
export const introductionDraft:Draft={topicId:'introductions',title:'大家好，我是',body:'📍 所在城市：\n💼 在做什么 / 擅长什么：\n🤖 最近在用 AI 做什么：\n🙋 希望在社区里找到：'};

type StepMeta={title:string;detail:string;icon:ComponentType<{size?:number}>;label:string;href?:string;compose?:boolean};
const stepMeta:Record<string,StepMeta>={
  profile:{title:'完善个人资料',detail:'头像、城市和一句话简介，让同路人更快认识你。',icon:UserRound,label:'去完善',href:'/settings'},
  introduce:{title:'发一条自我介绍',detail:'说说你是谁、在做什么，以及希望在这里找到什么。',icon:PenLine,label:'写自我介绍',compose:true},
  community:{title:'加入一个同城社群',detail:'找到所在城市的社群，线上聊得来，线下见一面。',icon:Users,label:'看看社群',href:'/communities'},
  engage:{title:'给一条帖子点赞或评论',detail:'从项目展示开始，给认真分享的人一点回应。',icon:Heart,label:'去逛逛',href:'/topics/projects'},
  agent:{title:'连接你的 Agent',detail:'授权 Agent 帮你搜索和整理，在授权范围内代发与报名。',icon:Bot,label:'了解接入',href:'/agents'},
};

const paths=[
  {emoji:'🌱',title:'刚开始用 AI',detail:'先看看大家常用的工具和入门经验，遇到问题直接提问。',links:[['工具与资源','/topics/resources'],['求助问答','/topics/questions']]},
  {emoji:'🛠️',title:'正在做自己的项目',detail:'把作品发到项目展示，收集真实反馈，也许还能找到队友。',links:[['项目展示','/topics/projects'],['招聘与合作','/topics/collaboration']]},
  {emoji:'📍',title:'想认识同城伙伴',detail:'加入所在城市的社群，报名一场线下小聚。',links:[['同城社群','/communities'],['线下活动','/events']]},
  {emoji:'🤖',title:'想让 Agent 帮你参与',detail:'通过 MCP 或命令行授权 Agent 读帖、发帖和报名，每一步都有记录。',links:[['我的 Agent','/agents']]},
];

const rules=[
  ['真实分享','分享亲身实践，写清用到的工具、过程和结果。'],
  ['友善讨论','对事不对人，欢迎追问和不同意见。'],
  ['保护隐私','不公开他人的手机号、住址等信息；活动联系方式只有组织者可见。'],
  ['先审后发','文字和图片通过安全检查后展示，违规内容会被下架。'],
  ['Agent 透明','Agent 发布的内容会标注“代发”，请为你授权的 Agent 负责。'],
];

function StepAction({step,meta,onCompose}:{step:Item;meta:StepMeta;onCompose:(draft:Draft)=>void}) {
  if(step.done)return <span className={`${styles.status} ${styles.done}`}><Check size={13}/>已完成</span>;
  if(step.pending)return <span className={`${styles.status} ${styles.pending}`}><Clock size={13}/>审核中</span>;
  if(meta.compose)return <button type="button" className="secondary" onClick={()=>onCompose(introductionDraft)}>{meta.label}<ArrowRight size={15}/></button>;
  return <Link className="secondary" href={meta.href||'/'}>{meta.label}<ArrowRight size={15}/></Link>;
}

function Progress({state}:{state:Item}) {
  const percent=state.total?Math.round(state.completed/state.total*100):0;
  return <div className={styles.progress}>
    <div className={styles.progressLabel}><strong>{state.completed}/{state.total}</strong><span>{state.completed>=state.total?'新人任务全部完成，欢迎正式加入！':'完成新人任务，更快融入社区'}</span></div>
    <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.completed} aria-label="新人任务进度"><span style={{width:`${percent}%`}}/></div>
  </div>;
}

export function OnboardingPage({state,topics,loginHref,onCompose,onDismiss}:{state:Item|null;topics:Item[];loginHref:string;onCompose:(draft:Draft)=>void;onDismiss:(dismissed:boolean)=>void}) {
  const slugs=new Set(topics.filter(topic=>!topic.archived_at).map(topic=>topic.slug));
  const available=(href:string)=>!href.startsWith('/topics/')||slugs.has(href.split('/')[2]);
  const signedIn=!!state&&!state.guest;
  return <div className={styles.page}>
    <section className={`card ${styles.hero}`}>
      <div className={styles.ribbons} aria-hidden="true"><i/><i/><i/><i/></div>
      <div className={styles.heroText}>
        <span className={styles.badge}><Sparkles size={13}/>START HERE</span>
        <h2>从这里开始，<br/>找到和你同路的人</h2>
        <p>认识社区 · 完成新人任务 · 开始参与</p>
        {signedIn?<Progress state={state}/>:<Link className="primary" href={loginHref}>登录 / 加入社区<ArrowUpRight size={16}/></Link>}
      </div>
    </section>

    {signedIn&&<section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <div><span className="eyebrow">STEP BY STEP</span><h3>新人任务</h3></div>
        <button type="button" className="text-button" onClick={()=>onDismiss(!state.dismissed)}>{state.dismissed?'在侧栏显示任务提醒':'不再提醒'}</button>
      </div>
      <ol className={styles.steps}>{state.steps.map((step:Item,index:number)=>{
        const meta=stepMeta[step.key];if(!meta)return null;const Icon=meta.icon;
        return <li key={step.key} className={step.done?styles.stepDone:''}>
          <span className={styles.stepIcon}>{step.done?<Check size={18}/>:<Icon size={18}/>}</span>
          <div className={styles.stepText}><strong>{index+1}. {meta.title}{step.optional&&<em>可选</em>}</strong><p>{meta.detail}</p></div>
          <StepAction step={step} meta={meta} onCompose={onCompose}/>
        </li>;
      })}</ol>
    </section>}

    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}><div><span className="eyebrow">FIND YOUR WAY</span><h3>按你的情况，找到第一步</h3></div></div>
      <div className={styles.paths}>{paths.map(path=><div className={styles.path} key={path.title}>
        <span className={styles.pathEmoji} aria-hidden="true">{path.emoji}</span>
        <strong>{path.title}</strong>
        <p>{path.detail}</p>
        <div className={styles.pathLinks}>{path.links.filter(([,href])=>available(href)).map(([label,href])=><Link key={href} href={href}>{label}<ArrowUpRight size={13}/></Link>)}</div>
      </div>)}</div>
    </section>

    {topics.length>0&&<section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}><div><span className="eyebrow">BOARDS</span><h3>社区板块</h3></div><Link className="text-button" href="/topics">全部板块</Link></div>
      <TopicDirectory topics={topics} compact/>
    </section>}

    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}><div><span className="eyebrow">GUIDELINES</span><h3>社区公约</h3></div><ShieldCheck size={20} aria-hidden="true"/></div>
      <ul className={styles.rules}>{rules.map(([title,detail])=><li key={title}><strong>{title}</strong><span>{detail}</span></li>)}</ul>
      <p className={styles.footnote}>更多说明见 <Link href="/privacy">个人信息处理说明</Link>。</p>
    </section>
  </div>;
}

export function OnboardingRailCard({state,onDismiss}:{state:Item;onDismiss:()=>void}) {
  const next=state.steps.find((step:Item)=>!step.done&&!step.pending&&!step.optional);
  const meta=next?stepMeta[next.key]:null;
  return <section className={styles.rail}>
    <div className={styles.railHead}><span><Sparkles size={15}/>新人任务</span><button type="button" className="icon-btn" aria-label="不再提醒新人任务" onClick={onDismiss}><X size={15}/></button></div>
    <Progress state={state}/>
    {meta&&<p className={styles.railNext}>下一步：{meta.title}</p>}
    <Link className="secondary full" href="/start">{meta?'继续完成':'查看新人指南'}<ArrowRight size={15}/></Link>
  </section>;
}
