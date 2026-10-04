'use client';
import { useCallback,useEffect,useRef,useState,type FormEvent,type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname,useRouter } from 'next/navigation';
import { Home,Compass,Users,CalendarDays,Bot,Bell,Search,Plus,ArrowUpRight,MessageCircle,Heart,Repeat2,Bookmark,ImagePlus,Video,Link2,X,MapPin,Clock,ChevronRight,Lock,Globe,Settings,LogOut,ShieldCheck,Check,Copy,RefreshCw,ExternalLink,Ellipsis,ArrowLeft,Code2,Terminal,Send,CheckCircle2 } from 'lucide-react';
import { contracts,scopeLabels,scopes,type Item,type Action } from '@/shared/contracts';
import { extractWebUrls } from '@/shared/links';
import { InvitationManager } from './invitation-manager';
import { ModerationPanel } from './moderation-panel';
import { PublicationUpdates } from './publication-updates';
import { AdminStats } from './admin-stats';
import { AdminContentPanel } from './admin-content-panel';
import adminContentStyles from './admin-content-panel.module.css';
import { PresenceHeartbeat } from './presence-heartbeat';
import { Avatar } from './avatar';
import { ProfileSettings } from './profile-settings';
import { PrivacyPolicy } from './privacy-policy';
import { PrivacySettings } from './privacy-settings';
import { DouyinEmbed } from './douyin-embed';
import { UploadedVideo } from './uploaded-video';
import videoStyles from './uploaded-video.module.css';
import { isVideoMime,MAX_VIDEO_BYTES } from '@/shared/video';
import { PRIVACY_VERSION } from '@/shared/privacy';

async function api(path:string,method='GET',body?:unknown) {
  const response=await fetch(`/api/v1/${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok) throw new Error(data.error||'操作失败');return data;
}
const act=(action:Action,input:unknown={})=>api(`actions/${action}`,'POST',input);
const date=(s:string)=>new Date(s).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'});
function ago(s:string){const m=Math.max(0,Math.floor((Date.now()-new Date(s).getTime())/60000));return m<1?'刚刚':m<60?`${m} 分钟前`:m<1440?`${Math.floor(m/60)} 小时前`:new Date(s).toLocaleDateString('zh-CN',{month:'long',day:'numeric'});}
function Modal({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
  return <dialog ref={ref} className="modal" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget) onClose();}}><div className="modal-head"><h2>{title}</h2><button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
function Empty({title='这里还没有内容',detail='分享你的第一个发现，开启讨论。'}:{title?:string;detail?:string}){return <div className="empty"><MessageCircle size={30}/><h3>{title}</h3><p>{detail}</p></div>;}
function Field({label,children}:{label:string;children:ReactNode}){return <label className="field"><span>{label}</span>{children}</label>;}

export default function CommunityApp(){
  const path=usePathname();const router=useRouter();const [me,setMe]=useState<Item|null>(null),[dev,setDev]=useState(false),[inviteOnly,setInviteOnly]=useState(true),[storedData,setData]=useState<Item>({}),[communities,setCommunities]=useState<Item[]>([]),[events,setEvents]=useState<Item[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[toast,setToast]=useState(''),[revision,setRevision]=useState(0),[feed,setFeed]=useState('latest'),[modal,setModal]=useState(''),[original,setOriginal]=useState<Item|null>(null),[busy,setBusy]=useState(false),[term,setTerm]=useState(''),[searchType,setSearchType]=useState('all'),[city,setCity]=useState(''),[token,setToken]=useState('');
  const segments=path.split('/').filter(Boolean);const section=segments[0]||'home',id=segments[1];
  const [lastPublication,setLastPublication]=useState<Item|null>(null);
  const loadedPage=useRef(''),loadSequence=useRef(0);
  const pageKey=JSON.stringify([path,me?.id,feed,term,searchType,city]);
  const data=loadedPage.current===pageKey?storedData:{};
  useEffect(()=>{setModal('');setOriginal(null);setToken('');setLastPublication(null);},[me?.id]);
  const refresh=useCallback(()=>setRevision(n=>n+1),[]);const needLogin=()=>{if(!me){router.push('/login');return false;}return true;};
  const run=async(fn:()=>Promise<unknown>,message='已完成')=>{setBusy(true);try {const value=await fn();if(value&&typeof value==='object'&&'moderationId' in value)setLastPublication({id:value.moderationId,authorId:me?.id});setToast(message);refresh();return value;}catch(e){setToast((e as Error).message);return null;}finally{setBusy(false);}};
  useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(''),4200);return()=>clearTimeout(t);}},[toast]);
  useEffect(()=>{let valid=true;api('me').then(r=>{if(valid){setMe(r.user);setDev(r.dev);setInviteOnly(r.inviteOnly!==false);}}).catch(()=>{});return()=>{valid=false;};},[revision,path]);
  useEffect(()=>{let valid=true;Promise.all([api('communities'),api('events')]).then(([c,e])=>{if(valid){setCommunities(c.items);setEvents(e.items);}}).catch(()=>{});return()=>{valid=false;};},[revision,path]);
  useEffect(()=>{
    let valid=true;const sequence=++loadSequence.current;const samePage=loadedPage.current===pageKey;
    async function pages(endpoint:string,key='items'){
      const previous=samePage?(data[key]||[]):[];const tail=previous.at(-1)?.id;
      let result=await api(endpoint),items=result[key]||[],count=1;
      const maxPages=Math.ceil(previous.length/20)+1;
      while(valid&&result.nextCursor&&tail&&!items.some((item:Item)=>item.id===tail)&&count<maxPages){
        result=await api(`${endpoint}&cursor=${encodeURIComponent(result.nextCursor)}`);items=[...items,...(result[key]||[])];count++;
      }
      return {...result,[key]:items};
    }
    if(loadedPage.current!==pageKey){setLoading(true);setData({});}setError('');
    async function load(){
      if(section==='login'||section==='consent') return {};
      if(section==='privacy')return api('privacy/policy');
      if(section==='privacy-settings'||section==='moderation')return {};
      if(section==='home') return pages(`posts?feed=${feed}`);
      if(section==='posts') return {post:await api(`posts/${id}`)};
      if(section==='communities') {if(!id) return api('communities');const c=await api(`communities/${id}`);let posts={items:[]};try {posts=await api(`posts?communityId=${id}`);}catch{}let members={items:[]};if(c.membership_status==='active')try{members=await api(`communities/${id}/members`);}catch{}return {community:c,posts:posts.items,members:members.items};}
      if(section==='events') {if(!id)return api('events');const e=await api(`events/${id}`);let attendees={items:[]};if(e.canManage)try{attendees=await api(`events/${id}/attendees`);}catch{}return {event:e,attendees:attendees.items};}
      if(section==='profile') {
        if(!id) {
          const {user}=await api('me');
          if(valid)router.replace(user?`/profile/${encodeURIComponent(user.id)}`:'/login');
          return {};
        }
        return {profile:await api(`profiles/${id}`),posts:(await api(`posts?authorId=${id}`)).items};
      }
      if(section==='agents')return api('grants');if(section==='notifications')return api('notifications');if(section==='admin')return api('admin');
      if(section==='discover')return term?pages(`search?q=${encodeURIComponent(term)}&type=${searchType}&city=${encodeURIComponent(city)}`,'posts'):{posts:[],communities:[],events:[]};
      return {};
    }
    load().then(r=>{if(valid&&sequence===loadSequence.current){loadedPage.current=pageKey;setData(r);}}).catch(e=>{if(valid&&sequence===loadSequence.current){if(samePage)setToast('暂时无法刷新，已保留当前页面。');else setError(e.message);}}).finally(()=>{if(valid&&sequence===loadSequence.current)setLoading(false);});
    return()=>{valid=false;};
  },[path,me?.id,revision,feed,term,searchType,city]);
  async function loadMore(){const sequence=++loadSequence.current;setBusy(true);try{const endpoint=section==='discover'?`search?q=${encodeURIComponent(term)}&type=${searchType}&city=${encodeURIComponent(city)}`:`posts?feed=${feed}`;const result=await api(`${endpoint}&cursor=${encodeURIComponent(data.nextCursor)}`);const key=section==='discover'?'posts':'items';if(sequence!==loadSequence.current)return;setData(old=>({...old,...result,[key]:[...(old[key]||[]),...(result[key]||[])]}));}catch(e){setToast((e as Error).message);}finally{setBusy(false);}}
  const logout=async()=>{await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});setMe(null);refresh();router.push('/');};
  const createPost=(post?:Item)=>{if(needLogin()){setOriginal(post||null);setModal('post');}};
  const nav=[{path:'/',label:'社区动态',icon:Home,key:'home'},{path:'/discover',label:'发现',icon:Compass,key:'discover'},{path:'/communities',label:'同城社群',icon:Users,key:'communities'},{path:'/events',label:'线下活动',icon:CalendarDays,key:'events'},{path:'/agents',label:'我的 Agent',icon:Bot,key:'agents'},{path:'/notifications',label:'消息',icon:Bell,key:'notifications'},{path:'/moderation',label:'我的发布',icon:ShieldCheck,key:'moderation'}];
  const communityCards=(items:Item[])=>items.length?<div className="community-grid">{items.map(c=><Link href={`/communities/${c.id}`} key={c.id} className="community-card"><div className="community-mark"><Users size={26}/><span>{c.visibility==='private'?<Lock size={15}/>:<Globe size={15}/>}</span></div><h3>{c.name}</h3><p>{c.description}</p><div className="card-meta"><span><MapPin size={14}/>{c.city}</span><span>{c.member_count} 位成员</span></div></Link>)}</div>:<Empty title="还没有社群" detail="创建一个同城社群，找到一起实践 AI 的伙伴。"/>;
  const eventCards=(items:Item[])=>items.length?<div className="event-list">{items.map(e=><Link href={`/events/${e.id}`} className="event-card" key={e.id}><div className="date-block"><span>{new Date(e.starts_at).getMonth()+1} 月</span><strong>{new Date(e.starts_at).getDate()}</strong></div><div className="event-info"><span className="eyebrow">{e.community_name}</span><h3>{e.title}</h3><p><MapPin size={14}/>{e.city}<span>·</span>{date(e.starts_at)}</p><span className="muted">{e.registrationCount} / {e.capacity} 人报名 {e.cancelled?' · 已取消':e.attending?' · 已报名':''}</span></div><ArrowUpRight size={20}/></Link>)}</div>:<Empty title="暂时没有活动" detail="在社群里发起一次见面，把线上交流带到线下。"/>;







  const title=section==='home'?'社区动态':section==='discover'?'发现灵感':section==='communities'?'同城社群':section==='events'?'线下活动':section==='agents'?'我的 Agent':section==='notifications'?'消息':section==='profile'?'个人主页':section==='settings'?'个人设置':section==='privacy'?'个人信息处理说明':section==='privacy-settings'?'隐私与个人信息':section==='moderation'?'我的发布记录':section==='admin'?'社区管理':section==='posts'?'帖子详情':'欢迎加入';
  const context={me,setToast,run,needLogin,createPost,busy,router,setTerm,section,id,original,communities,setModal,token,setToken,refresh,dev,inviteOnly};
  return <div className="app-shell">
    {me&&<PresenceHeartbeat key={me.id} userId={me.id}/>}
    <aside className="sidebar"><Link href="/" className="brand"><span className="brand-mark">ai<span>+</span></span><strong>AI 社区</strong><span className="beta">BETA</span></Link><nav>{nav.map(n=><Link href={n.path} key={n.key} className={`nav-item ${section===n.key?'active':''}`}><n.icon size={21}/><span>{n.label}</span></Link>)}</nav><button className="primary write-button" onClick={()=>createPost()}><Plus size={20}/>发布动态</button><div className="sidebar-bottom">{me?<><Link className="account" href={`/profile/${me.id}`}><Avatar image={me.image} name={me.name}/><div><strong>{me.name}</strong><span>@{me.handle}</span></div><ChevronRight size={16}/></Link><div className="account-tools"><Link href="/settings"><Settings size={16}/>设置</Link>{me.role==='admin'&&<Link href="/admin"><ShieldCheck size={16}/>管理</Link>}<button onClick={async()=>{await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});setMe(null);refresh();router.push('/');}}><LogOut size={16}/>退出</button></div></>:<Link className="secondary full" href="/login">登录 / 加入社区<ArrowUpRight size={17}/></Link>}</div></aside>
    <main className="main"><header className="page-header"><div>{id&&<Link href={`/${section==='posts'||section==='profile'?'':section}`} className="back" aria-label="返回"><ArrowLeft size={18}/></Link>}<h1>{title}</h1></div><Link className="icon-btn header-account" href="/notifications" aria-label="站内消息"><Bell size={18}/></Link><Link className="header-account" href={me ? `/profile/${me.id}` : '/login'}>{me ? <Avatar image={me.image} name={me.name} size="small"/> : '登录'}</Link><button className="icon-btn" title="刷新" aria-label="刷新内容" onClick={refresh}><RefreshCw size={18}/></button></header>
    {dev&&section==='admin'&&me?.role==='admin'&&<div className="dev-banner">本地体验环境 · 示例内容已标记，短信与 AI 凭据尚未配置时不调用真实服务。</div>}
    {me&&!['login','consent','admin','moderation','privacy','privacy-settings'].includes(section)&&<PublicationUpdates key={me.id} revision={revision} submission={lastPublication?.authorId===me.id?lastPublication?.id||'':''} onPublished={refresh}/>}
    {error?<div className="error-banner"><p>{error}</p>{!me?<Link href="/login">前往登录</Link>:<button onClick={refresh}>重试</button>}</div>:loading&&section!=='discover'?<div className="loading"><span className="spinner"/>正在加载…</div>:<>
      {section==='home'&&<><div className="feed-tabs">{[['latest','最新动态'],['following','正在关注'],['bookmarks','我的收藏']].map(([k,t])=><button key={k} className={feed===k?'selected':''} onClick={()=>{if(k==='latest'||needLogin())setFeed(k);}}>{t}</button>)}</div><div className="composer-preview"><Avatar image={me?.image} name={me?.name||'我'}/><button onClick={()=>createPost()}>有什么新的发现？和大家聊聊。</button><button aria-label="分享图片" className="icon-btn" onClick={()=>createPost()}><ImagePlus size={20}/></button></div>{data.items?.length?data.items.map((p:Item)=><PostCard ctx={context} key={p.id} post={p}/>):<Empty/>}{data.nextCursor&&<button className="secondary load-more" disabled={busy} onClick={loadMore}>加载更多</button>}</>}
      {section==='posts'&&data.post&&<PostCard ctx={context} post={data.post} detail/>}
      {section==='discover'&&<div className="page-content"><div className="section-intro"><span className="eyebrow">DISCOVER</span><h2>好项目，值得被发现。</h2><p>搜索实践经验、开源工具，还有一起动手的人。</p></div><div className="search-box large"><Search size={21}/><input aria-label="搜索社区" value={term} onChange={e=>setTerm(e.target.value)} placeholder="搜索帖子、GitHub 项目、社群、活动"/></div><div className="filter-row"><select aria-label="内容类型" value={searchType} onChange={e=>setSearchType(e.target.value)}><option value="all">全部内容</option><option value="posts">帖子</option><option value="github">GitHub 项目</option><option value="communities">社群</option><option value="events">活动</option></select><input aria-label="城市筛选" placeholder="全部城市" value={city} onChange={e=>setCity(e.target.value)}/></div>{!term?<div className="topic-cloud">{['Agent','开源','工作流','AI 编程','杭州','创作'].map(t=><button key={t} onClick={()=>setTerm(t)}>#{t}<ArrowUpRight size={16}/></button>)}</div>:<>{data.posts?.map((p:Item)=><PostCard ctx={context} key={p.id} post={p}/>)}{data.nextCursor&&<button className="secondary load-more" disabled={busy} onClick={loadMore}>加载更多</button>}{!!data.communities?.length&&communityCards(data.communities)}{!!data.events?.length&&eventCards(data.events)}{!data.posts?.length&&!data.communities?.length&&!data.events?.length&&<Empty title="没有找到相关内容" detail="试试其他关键词，或去发布一个问题。"/>}</>}</div>}
      {section==='communities'&&!id&&<div className="page-content"><div className="section-intro"><span className="eyebrow">FIND YOUR PEOPLE</span><h2>线上聊得来，线下见一面。</h2><p>找到你的城市，和同路人一起创造。</p><button className="secondary" onClick={()=>{if(needLogin())setModal('community');}}><Plus size={17}/>创建社群</button></div>{communityCards(data.items||[])}</div>}
      {section==='communities'&&id&&data.community&&<><div className="community-cover"><div className="community-cover-pattern"/><span className="cover-label">{data.community.city} / AI COMMUNITY</span><Users size={48}/></div><div className="detail-head"><span className="pill">{data.community.visibility==='private'?<Lock size={13}/>:<Globe size={13}/>} {data.community.visibility==='private'?'私密社群':'公开社群'}</span><h2>{data.community.name}</h2><p>{data.community.description}</p><div className="detail-meta"><span><MapPin size={15}/>{data.community.city}</span><span><Users size={15}/>{data.community.member_count} 位成员</span></div><div className="detail-actions">{data.community.membership_status==='active'?<><button className="primary" onClick={()=>createPost()}><Plus size={17}/>发布社群动态</button>{data.community.owner_id!==me?.id&&<button className="text-button" onClick={()=>run(()=>act('communities_leave',{id}),'已退出社群')}>退出社群</button>}</>:<button className="primary" disabled={busy||data.community.membership_status==='pending'} onClick={()=>{if(needLogin())run(()=>act('communities_join',{id}),'加入请求已处理');}}>{data.community.membership_status==='pending'?'等待管理员批准':data.community.visibility==='private'?'申请加入':'加入社群'}</button>}{data.community.membership_role==='admin'&&<><button className="secondary" onClick={()=>setModal('event')}>发起活动</button><button className="text-button" onClick={()=>{const announcement=prompt('编辑社群公告',data.community.announcement);if(announcement!==null)run(()=>act('communities_announcement',{id,announcement}),'公告已提交审核，通过前展示原公告');}}>编辑公告</button></>}</div>{data.community.announcement&&<div className="announcement"><Bell size={16}/><p>{data.community.announcement}</p></div>}{data.community.membership_role==='admin'&&data.members?.some((m:Item)=>m.status==='pending')&&<div className="requests"><h3>加入申请</h3>{data.members.filter((m:Item)=>m.status==='pending').map((m:Item)=><div className="member-row" key={m.id}><Avatar image={m.image} name={m.name} size="small"/><span>{m.name}</span><button onClick={()=>run(()=>act('communities_approve',{id,userId:m.id,approved:true}),'已批准')}>批准</button><button onClick={()=>run(()=>act('communities_approve',{id,userId:m.id,approved:false}),'已拒绝')}>拒绝</button></div>)}</div>}</div>{data.community.membership_role==='admin'&&<details className="detail-head"><summary>社群成员管理</summary>{data.members?.filter((m:Item)=>m.status==='active').map((m:Item)=><div className="member-row" key={m.id}><Avatar image={m.image} name={m.name} size="small"/><span>{m.name}</span>{m.id===data.community.owner_id?<span className="muted">创建者</span>:<button disabled={busy} onClick={()=>{if(confirm('将这位成员移出社群？'))run(()=>act('communities_remove',{id,userId:m.id}),'成员已移出社群');}}>移出社群</button>}</div>)}</details>}<div className="feed-label"><span>社群讨论</span></div>{data.posts?.length?data.posts.map((p:Item)=><PostCard ctx={context} key={p.id} post={p}/>):<Empty title={data.community.visibility==='private'&&data.community.membership_status!=='active'?'加入后查看社群内容':'开启第一场讨论'}/>}</>}
      {section==='events'&&!id&&<div className="page-content"><div className="section-intro"><span className="eyebrow">MEET IN REAL LIFE</span><h2>把“有空聊聊”，变成一次见面。</h2><p>工作坊、小聚、一起做项目。找到下一场想参加的活动。</p><button className="secondary" onClick={()=>{if(needLogin())setModal('event');}}><Plus size={17}/>发起活动</button></div>{eventCards(data.items||[])}</div>}
      {section==='events'&&id&&data.event&&<div className="page-content"><div className="event-detail-cover"><CalendarDays size={42}/><span>{date(data.event.starts_at)}</span></div><span className="eyebrow">{data.event.community_name}</span><h2 className="detail-title">{data.event.title}</h2><div className="event-facts"><p><Clock size={18}/>{date(data.event.starts_at)} — {date(data.event.ends_at)}</p><p><MapPin size={18}/>{data.event.city} · {data.event.address||'详细地址报名成功后可见'}</p><p><Users size={18}/>{data.event.registrationCount} / {data.event.capacity} 人 · 免费参加</p></div><div className="capacity-track"><span style={{width:`${Math.min(100,data.event.registrationCount/data.event.capacity*100)}%`}}/></div><p className="long-text">{data.event.description}</p><button className={data.event.attending?'secondary':'primary'} disabled={busy||!data.event.attending&&(data.event.cancelled||new Date(data.event.starts_at)<=new Date())} onClick={()=>{if(!needLogin())return;if(data.event.attending)run(()=>act('events_rsvp',{id,attending:false}),'已取消报名');else setModal('registration');}}>{data.event.attending?'取消报名':data.event.cancelled?'活动已取消':'填写信息并预约'}<ArrowUpRight size={17}/></button>{data.event.recap&&<section className="recap"><h3>活动回顾</h3><p className="long-text">{data.event.recap}</p></section>}{data.event.canManage&&<section className="recap"><h3>组织者管理</h3><div className="filter-row"><button className="secondary" onClick={()=>{const recap=prompt('填写活动回顾',data.event.recap);if(recap!==null)run(()=>act('events_update',{id,recap}),'回顾已提交审核');}}>编辑回顾</button><button className="text-button danger" onClick={()=>{if(confirm('确认取消此活动？'))run(()=>act('events_update',{id,cancelled:true}),'活动已取消');}}>取消活动</button></div>{data.attendees?.map((m:Item)=><div className="member-row" key={m.id}><Avatar image={m.image} name={m.name} size="small"/><span className="attendee-contact"><strong>{m.name}</strong><small>{m.phoneNumber||'未提供手机号（历史报名）'}</small></span><button disabled={busy||!!m.checked_in_at} onClick={()=>run(()=>act('events_checkin',{id,userId:m.id}),'签到成功')}>{m.checked_in_at?'已签到':'签到'}</button></div>)}</section>}</div>}
      {section==='profile'&&data.profile&&<><div className="detail-head profile-head"><Avatar image={data.profile.image} name={data.profile.name} size="large"/><h2>{data.profile.name}</h2><span className="muted">@{data.profile.handle} · {data.profile.city||'还未填写城市'}</span><p>{data.profile.bio||'正在探索 AI 的更多可能。'}</p><div className="profile-counts"><span><strong>{data.profile.following}</strong> 关注</span><span><strong>{data.profile.followers}</strong> 关注者</span></div>{me?.id===id?<Link className="secondary" href="/settings">编辑资料</Link>:<button className="primary" onClick={()=>{if(needLogin())run(()=>act('follows_set',{id,active:!data.profile.followed}),'关注已更新');}}>{data.profile.followed?'取消关注':'关注'}</button>}</div>{data.posts?.map((p:Item)=><PostCard ctx={context} key={p.id} post={p}/>)}</>}
      {section==='agents'&&<div className="page-content"><div className="section-intro agent-intro"><Bot size={34}/><h2>让你的 Agent，也加入讨论。</h2><p>搜索社区、整理发现，或在你的授权范围内发布与报名。每一步都有记录。</p><button className="primary" onClick={()=>{if(needLogin())setModal('grant');}}><Plus size={17}/>连接 Agent</button></div><div className="connection-guide"><h3><Terminal size={18}/>接入方式</h3><p>MCP 服务地址</p><code>{typeof location!=='undefined'?location.origin:''}/mcp</code><p>CLI 使用环境变量配置地址与令牌</p><code>AICOMMUNITY_URL=你的社区地址<br/>AICOMMUNITY_TOKEN=你的授权令牌<br/>aicommunity search &quot;Agent&quot; --json</code><Link href="/api/v1/openapi.json" target="_blank">查看 API 文档<ExternalLink size={14}/></Link></div><h3>已授权的 Agent</h3>{data.items?.length?data.items.map((g:Item)=><div className="grant-card" key={g.id}><div className="grant-top"><Bot size={22}/><strong>{g.name}</strong><span className="muted">{g.revoked_at?'已撤销':new Date(g.expires_at)<new Date()?'已过期':'已连接'}</span></div><div className="tags">{g.scopes.map((s:string)=><span key={s}>{scopeLabels[s]||s}</span>)}</div><p className="muted">有效至 {date(g.expires_at)} · {g.community_ids.length} 个社群</p>{!g.revoked_at&&<button className="text-button danger" disabled={busy} onClick={()=>run(()=>act('grants_revoke',{id:g.id}),'授权已撤销')}>撤销授权</button>}</div>):<Empty title="还没有连接 Agent" detail="创建一个按能力授权的令牌，或通过 MCP 客户端发起连接。"/>}<h3>最近的代操作</h3>{data.logs?.length?data.logs.map((l:Item,i:number)=><div className="audit-row" key={i}><CheckCircle2 size={15}/><span>{l.action}</span><time>{date(l.created_at)}</time></div>):<p className="muted">还没有 Agent 操作记录。</p>}</div>}
      {section==='notifications'&&<div className="page-content"><button className="text-button" onClick={()=>run(()=>act('notifications_read'),'已标记为已读')}>全部标为已读</button>{data.items?.length?data.items.map((n:Item)=><Link href={n.href} key={n.id} className={`notification ${n.read_at?'':'unread'}`}><Bell size={19}/><div><p>{n.text}</p><span>{ago(n.created_at)}</span></div><ChevronRight size={16}/></Link>):<Empty title="暂时没有新消息" detail="有人回复你时，会在这里通知。"/>}</div>}
      {section==='settings'&&<div className="page-content"><h2>让伙伴更了解你</h2><p className="muted">头像、昵称、城市和简介会展示在公开主页，请勿填写手机号或详细住址。城市和简介可留空。</p><Link className="secondary" href="/privacy-settings">隐私与个人信息</Link>{me?<ProfileSettings key={me.id} me={me as {id:string;name:string;city?:string;bio?:string;image?:string|null;role?:string}} busy={busy} onSave={input=>run(()=>act('profile_update',input),'资料已提交，审核通过后展示')} onLogout={logout}/>:<Link href="/login">请先登录</Link>}</div>}
      {section==='admin'&&me?.role==='admin'&&<div className="page-content"><h2>社区管理</h2>{me?.role==='admin'&&<AdminStats key={`stats:${me.id}`} revision={revision}/>}{me?.role==='admin'&&<AdminContentPanel key={`content:${me.id}`} revision={revision} onChanged={refresh}/>}
{me?.role==='admin'&&<ModerationPanel key={me?.id||'guest'} admin/>}{me?.role==='admin'&&<InvitationManager enabled={inviteOnly}/>}<h3>内容举报</h3>{data.reports?.length?data.reports.map((r:Item)=><div className="grant-card" key={r.id}><Link href={`/posts/${r.post_id}`}>查看被举报帖子</Link><p>{r.reason}</p><span>{r.status==='open'?'待处理':'已处理'}</span>{r.status==='open'&&<div className="filter-row"><button className="secondary" onClick={()=>run(()=>act('admin_moderate',{reportId:r.id,postId:r.post_id}),'内容已下架')}>下架内容</button><button className="text-button" onClick={()=>run(()=>act('admin_moderate',{reportId:r.id}),'举报已处理')}>结案</button></div>}</div>):<p className="muted">暂无举报</p>}<h3>处理任务</h3>{data.jobs?.map((j:Item)=><div className="grant-card" key={j.id}><strong>{j.kind} · {j.status}</strong><p>{j.error}</p><button onClick={()=>run(()=>act('jobs_retry',{id:j.id}),'已安排重试')}>重试</button></div>)}<h3>用户管理</h3>{data.users?.map((u:Item)=><div className="member-row" key={u.id}><Avatar image={u.image} name={u.name} size="small"/><span>{u.name}</span>{u.role!=='admin'&&<button onClick={()=>run(()=>act('admin_moderate',{userId:u.id,banned:!u.banned}),'账户状态已更新')}>{u.banned?'解除封禁':'暂停账户'}</button>}</div>)}<h3>服务用量</h3>{data.usage?.filter((u:Item)=>!u.key.startsWith('dev-otp')).map((u:Item)=><div className="audit-row" key={u.key}><span>{u.key}</span><strong>{u.count}</strong></div>)}</div>}
      {section==='privacy'&&<PrivacyPolicy operator={data.operator||''} contact={data.contact||''}/>}
      {section==='privacy-settings'&&<PrivacySettings/>}
      {section==='moderation'&&<div className="page-content"><ModerationPanel key={me?.id||'guest'}/></div>}
      {section==='login'&&<Login ctx={context}/>}{section==='consent'&&<Consent ctx={context}/>}
    </>}
    </main>
    <aside className="right-rail"><form className="search-box" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);setTerm(String(f.get('q')||''));router.push('/discover');}}><Search size={17}/><input name="q" aria-label="快捷搜索" placeholder="搜索你感兴趣的内容"/></form><section className="rail-section"><div className="rail-heading"><h3>下一次，线下见</h3><Link href="/events" aria-label="查看全部活动"><ArrowUpRight size={18}/></Link></div>{events.filter(e=>!e.cancelled&&new Date(e.starts_at)>new Date()).slice(0,3).map(e=><Link className="mini-event" href={`/events/${e.id}`} key={e.id}><div className="mini-date"><span>{new Date(e.starts_at).getMonth()+1}月</span><strong>{new Date(e.starts_at).getDate()}</strong></div><div><strong>{e.title}</strong><span>{e.city} · {e.registrationCount} 人已报名</span></div></Link>)}{!events.length&&<p className="muted">期待第一场见面。</p>}</section><section className="rail-section"><div className="rail-heading"><h3>发现同路人</h3><Link href="/communities" aria-label="查看全部社群"><ArrowUpRight size={18}/></Link></div>{communities.slice(0,3).map(c=><Link className="mini-community" href={`/communities/${c.id}`} key={c.id}><span className="mini-community-icon"><Users size={19}/></span><div><strong>{c.name}</strong><span>{c.city} · {c.member_count} 位成员</span></div><ChevronRight size={15}/></Link>)}</section><section className="agent-promo"><div><Bot size={25}/><span>AGENT READY</span></div><h3>你的灵感，<br/>也可以交给 Agent。</h3><p>连接你的助手，按权限搜索、分享和参与社区。</p><Link href="/agents">连接我的 Agent<ArrowUpRight size={16}/></Link></section><footer className="rail-footer">AI 社区 · 一起实践，一起成长<br/><Link href="/api/v1/openapi.json">开放 API</Link><span> · </span><Link href="/agents">CLI & MCP</Link><span> · </span><Link href="/privacy">个人信息处理说明</Link><span className="footer-version">v0.1 / 小规模试运营</span></footer></aside>
    <nav className="mobile-nav">{nav.slice(0,5).map(n=><Link key={n.key} href={n.path} className={section===n.key?'active':''}><n.icon size={20}/><span>{n.key==='home'?'动态':n.key==='communities'?'社群':n.key==='events'?'活动':n.key==='agents'?'Agent':n.label}</span></Link>)}</nav>
    {toast&&<div role="status" className="toast">{toast}</div>}{modal==='post'&&<Composer ctx={context}/>}{modal==='community'&&<CommunityForm ctx={context}/>}{modal==='event'&&<EventForm ctx={context}/>}{modal==='registration'&&data.event&&<RegistrationForm event={data.event} ctx={context}/>}{modal==='grant'&&<GrantForm ctx={context}/>}
  </div>;
}

function PostCard({post,detail=false,ctx}:{post:Item;detail?:boolean;ctx:Item & {communities:Item[]}}){
 const {me,setToast,run,needLogin,createPost,busy,router,setTerm}=ctx;

    const [reply,setReply]=useState(''),[showReply,setShowReply]=useState(detail),[menu,setMenu]=useState(false);
    const reaction=(kind:string)=>post.reactions?.find((r:Item)=>r.kind===kind)||{count:0,mine:false};
    async function moderateContent(targetType:'post'|'comment',targetId:string,decision:'hide'|'delete') {
      if(me?.role!=='admin'||busy)return;
      const name=targetType==='post'?'帖子':'评论';
      if(decision==='delete'&&!confirm(`确认删除这条${name}？删除后将不再展示，且不能通过“恢复显示”找回。`))return;
      setMenu(false);
      await run(async()=>{
        const result=await act('admin_content_moderate',{targetType,targetId,decision});
        if(detail&&targetType==='post')router.push('/');
        return result;
      },decision==='hide'?`${name}已隐藏，可在后台恢复。`:`${name}已删除。`);
    }
    return <article className="post-card">
      <div className="post-top"><Link href={`/profile/${post.author_id}`}><Avatar image={post.author?.image} name={post.author?.name}/></Link><div className="post-author"><Link href={`/profile/${post.author_id}`}><strong>{post.author?.name}</strong></Link><span>{post.author?.city||'AI 探索者'}<i>·</i>{ago(post.created_at)}</span></div>{post.agent_name&&<span className="agent-badge"><Bot size={13}/>{post.agent_name} 代发</span>}<div className="post-menu"><button className="icon-btn" aria-label="帖子操作" onClick={()=>setMenu(!menu)}><Ellipsis size={20}/></button>{menu&&<div className="dropdown"><button onClick={()=>{navigator.clipboard.writeText(`${location.origin}/posts/${post.id}`);setToast('链接已复制');setMenu(false);}}>复制链接</button>{me?.role==='admin'?<><button disabled={busy} onClick={()=>void moderateContent('post',post.id,'hide')}>隐藏帖子</button><button className="danger" disabled={busy} onClick={()=>void moderateContent('post',post.id,'delete')}>删除帖子</button></>:me?.id===post.author_id?<button disabled={busy} onClick={()=>{if(confirm('确定删除这条帖子？'))run(()=>act('posts_delete',{id:post.id}),'帖子已删除');}}>删除帖子</button>:<><button onClick={()=>{if(needLogin()){const reason=prompt('请填写举报原因');if(reason)run(()=>act('reports_create',{id:post.id,reason}),'举报已提交');}}}>举报内容</button><button onClick={()=>{if(needLogin())run(()=>act('blocks_set',{id:post.author_id,active:true}),'已屏蔽此用户');}}>屏蔽用户</button></>}</div>}</div></div>
      {post.community&&<Link className="post-community" href={`/communities/${post.community.id}`}>{post.community.visibility==='private'?<Lock size={12}/>:<Users size={12}/>} {post.community.name}</Link>}
      <Link href={`/posts/${post.id}`} className="post-body">{post.body}</Link>
      {post.tags?.length>0&&<div className="tags">{post.tags.map((tag:string)=><button key={tag} onClick={()=>{setTerm(tag);router.push('/discover');}}>#{tag}</button>)}</div>}
      {!!post.media?.length&&<div className={`media-grid count-${post.media.length}`}>{post.media.map((m:Item)=>isVideoMime(m.mime)?<UploadedVideo key={m.id} src={m.url} mime={m.mime}/>:<a key={m.id} href={m.url} target="_blank" rel="noreferrer"><img src={m.url} alt={m.description||'帖子图片'}/></a>)}</div>}
      {post.links?.map((l:Item)=>{
        const card=<a className={`link-card ${l.platform==='github'?'github-card':''}`} key={l.id} href={l.url} target="_blank" rel="noreferrer"><div className="link-icon">{l.platform==='github'?<Code2 size={24}/>:<Link2 size={22}/>}</div><div><span className="link-source">{l.platform==='github'?'GITHUB · 开源项目':l.platform==='xiaohongshu'?'小红书':l.platform==='douyin'?'抖音':new URL(l.url).hostname}</span><strong>{l.title||l.url.replace(/^https?:\/\//,'')}</strong>{l.description&&<p>{l.description}</p>}<span className="link-meta">{l.metadata?.language&&`${l.metadata.language} · `}{l.metadata?.stars!==undefined&&`★ ${l.metadata.stars} · `}{l.status==='pending'?'正在获取链接信息':l.status==='failed'?'暂未获取详情，可打开原链接':l.status==='partial'?'已保存链接预览':'查看来源'}{l.fetched_at&&` · ${ago(l.fetched_at)}更新`}</span></div><ArrowUpRight size={17}/></a>;
        return l.platform==='douyin'?<DouyinEmbed key={l.id} metadata={l.metadata} url={l.url} title={l.title} description={l.description}>{card}</DouyinEmbed>:card;
      })}
      {!!post.processing?.length&&<div className="processing-status">{post.processing.map((job:Item)=><div key={job.id}><span>{job.kind==='image'?'图片理解':'链接解析'}：{job.status==='pending'?'排队中':job.status==='processing'?'处理中':'暂时未完成'}</span>{['failed','blocked'].includes(job.status)&&<button className="text-button" disabled={busy} onClick={()=>run(()=>act('jobs_retry',{id:job.id}),'已安排重试')}>重试</button>}</div>)}</div>}
      {post.original&&<Link href={`/posts/${post.original.id}`} className="quote"><strong>{post.original.author?.name}</strong><p>{post.original.body}</p></Link>}
      <div className="post-actions"><button className={reaction('like').mine?'liked':''} aria-label="点赞" onClick={()=>{if(needLogin())run(()=>act('reactions_set',{id:post.id,kind:'like',active:!reaction('like').mine}),'已更新点赞');}}><Heart size={18}/><span>{reaction('like').count||'喜欢'}</span></button><button aria-label="评论" onClick={()=>setShowReply(!showReply)}><MessageCircle size={18}/><span>{post.comments?.length||'评论'}</span></button><button aria-label="引用转发" onClick={()=>createPost(post)}><Repeat2 size={18}/><span>{post.repostCount||'转发'}</span></button><button aria-label="收藏" className={reaction('bookmark').mine?'saved':''} onClick={()=>{if(needLogin())run(()=>act('reactions_set',{id:post.id,kind:'bookmark',active:!reaction('bookmark').mine}),'收藏已更新');}}><Bookmark size={18}/></button></div>
      {showReply&&<div className="replies">{post.comments?.map((c:Item)=><div className="reply" key={c.id}><Avatar image={c.image} name={c.name} size="small"/><div><strong>{c.name}</strong>{c.agent_name&&<span className="muted"> · Agent 代发</span>}<p>{c.body}</p>{me?.role==='admin'&&<div className={adminContentStyles.quickActions} role="group" aria-label="管理员评论操作"><button type="button" className="text-button" disabled={busy} onClick={()=>void moderateContent('comment',c.id,'hide')}>隐藏评论</button><button type="button" className="text-button danger" disabled={busy} onClick={()=>void moderateContent('comment',c.id,'delete')}>删除评论</button></div>}</div></div>)}<form className="reply-form" onSubmit={e=>{e.preventDefault();if(needLogin()&&reply.trim())run(async()=>{const result=await act('comments_create',{id:post.id,body:reply,idempotencyKey:crypto.randomUUID()});setReply('');return result;},'评论已发送，安全检查通过后自动展示。');}}><input aria-label="评论内容" placeholder="说说你的想法…" value={reply} onChange={e=>setReply(e.target.value)} maxLength={10000}/><button className="icon-btn" aria-label="发送评论" disabled={busy}><Send size={18}/></button></form></div>}
      {detail&&post.media?.some((m:Item)=>!isVideoMime(m.mime)&&(m.extracted_text||m.description))&&<details className="extraction"><summary>图片文字与内容描述</summary>{post.media.filter((m:Item)=>!isVideoMime(m.mime)).map((m:Item)=><div key={m.id}><p>{m.extracted_text}</p><p className="muted">AI 描述：{m.description||'尚未生成'}</p></div>)}</details>}
    </article>;
  }

function Composer({ctx}:{ctx:Item & {communities:Item[]}}){
  const {section,id,original,communities,me,run,setModal,setToast,busy}=ctx;
  const [imageAnalysisConsent,setImageAnalysisConsent]=useState(false);
  const [body,setBody]=useState(''),[links,setLinks]=useState(''),[media,setMedia]=useState<Item[]>([]),[communityId,setCommunityId]=useState(section==='communities'&&id?id:original?.community?.visibility==='private'?original.community_id:''),[uploading,setUploading]=useState(false),[error,setError]=useState('');
  const key=useRef(crypto.randomUUID());
  const uploadRequest=useRef<AbortController|null>(null),submitting=useRef(false),imageInput=useRef<HTMLInputElement>(null),videoInput=useRef<HTMLInputElement>(null);
  useEffect(()=>()=>{uploadRequest.current?.abort();uploadRequest.current=null;},[]);
  const detectedLinks=extractWebUrls(links);
  const hasVideo=media.some(m=>isVideoMime(m.mime));
  async function upload(files:File[],kind:'image'|'video'){
    if(!files.length||uploadRequest.current||submitting.current||busy)return;
    setError('');
    if(kind==='video'&&media.length){setError(hasVideo?'每帖只能添加 1 个视频，请先移除当前视频再更换。':'图片和视频不能同时发布，请先移除已选图片再添加视频。');return;}
    if(kind==='image'&&hasVideo){setError('图片和视频不能同时发布，请先移除已选视频再添加图片。');return;}
    if(kind==='video'&&files.length!==1){setError('每帖只能添加 1 个视频，已选内容保持不变。');return;}
    if(kind==='image'&&files.length+media.length>9){setError('每帖最多添加 9 张图片，请减少本次选择，已选内容保持不变。');return;}
    if(files.some(file=>kind==='video'?!isVideoMime(file.type):!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type))){setError(kind==='video'?'请选择 MP4 或 WebM 视频。':'请选择 JPG、PNG、WebP 或 GIF 图片。');return;}
    if(files.some(file=>file.size===0||file.size>(kind==='video'?MAX_VIDEO_BYTES:10*1024*1024))){setError(kind==='video'?'视频不能为空，且不能超过 50 MiB。':'图片不能为空，且每张不能超过 10 MB。');return;}
    const controller=new AbortController();uploadRequest.current=controller;setUploading(true);
    try {
      for(const file of files){
        const form=new FormData();if(kind==='image')form.set('file',file);
        const response=await fetch(kind==='video'?'/api/v1/media/video':'/api/v1/media',{method:'POST',headers:kind==='video'?{'Content-Type':file.type}:undefined,body:kind==='video'?file:form,signal:controller.signal});
        const result=await response.json().catch(()=>null);
        if(!response.ok||typeof result?.id!=='string'||typeof result?.url!=='string')throw new Error(result?.error||'上传失败，请稍后重试。');
        if(controller.signal.aborted||uploadRequest.current!==controller)return;
        setMedia(old=>[...old,{...result,mime:result.mime||file.type}]);
        if(kind==='video')setImageAnalysisConsent(false);
      }
    } catch(e){if(!controller.signal.aborted&&uploadRequest.current===controller){setError((e as Error).message);setToast((e as Error).message);}}
    finally{if(uploadRequest.current===controller){uploadRequest.current=null;setUploading(false);}}
  }
  function cancelUpload(){
    uploadRequest.current?.abort();uploadRequest.current=null;setUploading(false);setError('上传已取消，已上传的内容保持不变。');
  }
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();if(uploadRequest.current||submitting.current||busy)return;setError('');
    if(links.trim()&&!detectedLinks.length){setError('未识别到有效链接。请粘贴完整的 http:// 或 https:// 链接，也可以直接粘贴抖音、小红书的分享文案。');return;}
    if(detectedLinks.length>5){setError('一次最多分享 5 个链接，请减少后再发布。');return;}
    const parsed=contracts.posts_create.safeParse({body,links:detectedLinks,mediaIds:media.map(m=>m.id),imageAnalysisConsent:!hasVideo&&imageAnalysisConsent,communityId:communityId||undefined,originalId:original?.id,idempotencyKey:key.current});
    if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
    submitting.current=true;
    try{await run(async()=>{try{const result=await act('posts_create',parsed.data);setModal('');return result;}catch(e){setError((e as Error).message);throw e;}},hasVideo?'视频已提交，管理员审核通过后展示。':'已收到你的动态，安全检查通过后自动展示。');}
    finally{submitting.current=false;}
  }
  return <Modal title={original?'引用转发':'分享一个新发现'} onClose={()=>setModal('')}><form onSubmit={submit}>
    <div className="composer-author"><Avatar image={me?.image} name={me?.name}/><div><strong>{me?.name}</strong><select aria-label="发布范围" value={communityId} onChange={e=>setCommunityId(e.target.value)}><option value="">公开动态</option>{communities.filter(c=>c.membership_status==='active').map(c=><option key={c.id} value={c.id}>{c.visibility==='private'?'🔒 ':''}{c.name}</option>)}</select></div></div>
    <textarea className="write-area" aria-label="动态内容" placeholder="最近用 AI 做了什么？分享作品、开源项目，或一个值得讨论的问题…" value={body} onChange={e=>{setBody(e.target.value);setError('');}} maxLength={10000} autoFocus/>
    {original&&<div className="quote"><strong>{original.author?.name}</strong><p>{original.body}</p></div>}
    <Field label="分享链接或分享文案（可选）"><textarea rows={2} value={links} onChange={e=>{setLinks(e.target.value);setError('');}} maxLength={10000} placeholder="粘贴网址，或抖音、小红书的整段分享文案"/></Field>
    {detectedLinks.length>0&&<div className="composer-links"><span>已识别 {detectedLinks.length} 个链接</span><ul>{detectedLinks.slice(0,5).map(url=><li key={url}>{url}</li>)}</ul></div>}
    {hasVideo?media.map(m=><div className={videoStyles.videoPreview} key={m.id}><div className={videoStyles.previewHeading}><strong>待发布视频</strong><button type="button" className="text-button danger" disabled={busy||uploading} onClick={()=>{setMedia([]);setError('');}}>移除视频</button></div><UploadedVideo src={m.url} mime={m.mime} label="待发布视频预览"/></div>):media.length>0&&<div className="upload-previews">{media.map(m=><div key={m.id}><img src={m.url} alt="待发布图片"/><button type="button" aria-label="移除图片" disabled={busy||uploading} onClick={()=>{setMedia(media.filter(x=>x.id!==m.id));setError('');}}><X size={14}/></button></div>)}</div>}
    {media.length>0&&!hasVideo&&<label className="checkbox privacy-choice"><input type="checkbox" checked={imageAnalysisConsent} onChange={e=>setImageAnalysisConsent(e.target.checked)}/><span>允许将本次图片交给配置的 AI 服务提取文字和描述（可选，默认关闭；关闭仍可提交图片审核）。请勿上传身份证、医疗等私密资料。<Link href="/privacy" target="_blank">了解处理方式</Link></span></label>}
    <p className="moderation-submit-notice">{hasVideo?'视频需管理员人工审核，通过后按所选范围展示。':'文字和图片通过安全检查后展示。文字和图片会交给已配置的阿里云内容安全服务检测，与可选的图片文字提取用途不同。'}<Link href="/privacy" target="_blank">查看说明</Link></p>
    <p className={videoStyles.help}>最多 9 张图片，或 1 个 MP4 / WebM 视频（最大 50 MiB），图片和视频不能混选。</p>
    {uploading&&<div className={videoStyles.uploadProgress} role="status"><span>正在上传，请稍候…</span><button type="button" className="text-button" onClick={cancelUpload}>取消上传</button></div>}
    {error&&<p className="composer-error" role="alert">{error}</p>}
    <div className={`form-footer ${videoStyles.footer}`}><div className={videoStyles.uploadActions}><button type="button" className="upload-button" disabled={busy||uploading} onClick={()=>imageInput.current?.click()}><ImagePlus size={20}/>添加图片</button><button type="button" className="upload-button" disabled={busy||uploading} onClick={()=>videoInput.current?.click()}><Video size={20}/>添加视频</button></div><button type="submit" className="primary" disabled={busy||uploading}>{busy?'发布中…':'发布'}{communityId?'到社群':''}<ArrowUpRight size={17}/></button></div>
    <input ref={imageInput} className={videoStyles.fileInput} type="file" aria-label="选择帖子图片" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={busy||uploading} onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';void upload(files,'image');}}/>
    <input ref={videoInput} className={videoStyles.fileInput} type="file" aria-label="选择帖子视频" accept="video/mp4,video/webm" disabled={busy||uploading} onChange={event=>{const files=Array.from(event.currentTarget.files||[]);event.currentTarget.value='';void upload(files,'video');}}/>
  </form></Modal>;
}

function CommunityForm({ctx}:{ctx:Item & {communities:Item[]}}){
 const {run,setModal,router,busy}=ctx;
return <Modal title="创建同城社群" onClose={()=>setModal('')}><form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(async()=>{const r=await act('communities_create',Object.fromEntries(f));setModal('');return r;},'社群正在安全检查，通过后自动展示');}}><Field label="社群名称"><input name="name" minLength={2} maxLength={60} required placeholder="例如：杭州 AI 创造者"/></Field><Field label="所在城市"><input name="city" required maxLength={60} placeholder="杭州"/></Field><Field label="社群介绍"><textarea name="description" required rows={3} placeholder="这里聚集什么样的人？一起做什么？"/></Field><Field label="加入方式"><select name="visibility"><option value="public">公开社群 · 所有人可浏览，直接加入</option><option value="private">私密社群 · 申请后由管理员批准</option></select></Field><p className="moderation-submit-notice">名称、城市和介绍通过内容安全审核后展示。<Link href="/privacy">处理说明</Link></p><button className="primary full" disabled={busy}>创建社群</button></form></Modal>;}

function EventForm({ctx}:{ctx:Item & {communities:Item[]}}){
 const {communities,me,run,setModal,router,busy}=ctx;
return <Modal title="发起一次线下见面" onClose={()=>setModal('')}><form onSubmit={e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));run(async()=>{const r=await act('events_create',{...f,startsAt:new Date(String(f.startsAt)).toISOString(),endsAt:new Date(String(f.endsAt)).toISOString(),idempotencyKey:crypto.randomUUID()});setModal('');return r;},'活动正在安全检查，通过后自动展示');}}><Field label="所属社群"><select name="communityId" required>{communities.filter(c=>c.membership_role==='admin').map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="活动名称"><input name="title" required minLength={2} maxLength={120} placeholder="周末一起做一个 AI 小项目"/></Field><Field label="活动说明"><textarea name="description" required rows={3}/></Field><div className="form-grid"><Field label="城市"><input name="city" required defaultValue={me?.city||''}/></Field><Field label="人数上限"><input name="capacity" type="number" required min={1} max={1000} defaultValue={20}/></Field></div><Field label="详细地址（报名后可见）"><input name="address" required maxLength={500}/></Field><div className="form-grid"><Field label="开始时间"><input name="startsAt" type="datetime-local" required/></Field><Field label="结束时间"><input name="endsAt" type="datetime-local" required/></Field></div><p className="moderation-submit-notice">活动文字通过内容安全审核后展示。<Link href="/privacy">处理说明</Link></p><button className="primary full" disabled={busy}>发布活动</button></form></Modal>;}

function RegistrationForm({event,ctx}:{event:Item;ctx:Item & {communities:Item[]}}){
  const {run,setModal,busy}=ctx;
  const [error,setError]=useState('');
  async function submit(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');
    const form=new FormData(e.currentTarget);
    const parsed=contracts.events_rsvp.safeParse({id:event.id,attending:true,attendeeName:form.get('attendeeName'),phoneNumber:form.get('phoneNumber'),contactConsent:form.get('contactConsent')==='on'});
    if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
    await run(async()=>{
      try{await act('events_rsvp',parsed.data);setModal('');}
      catch(e){setError((e as Error).message);throw e;}
    },'预约成功');
  }
  return <Modal title="预约线下活动" onClose={()=>{if(!busy)setModal('');}}>
    <p className="registration-event">{event.title}</p>
    <p className="muted">请填写参加者姓名和可联系的手机号，用于活动联系与签到。信息仅向所属社群管理员展示。</p>
    <form onSubmit={submit}>
      <Field label="姓名"><input name="attendeeName" autoComplete="name" required maxLength={60} placeholder="请输入参加者姓名" autoFocus disabled={busy}/></Field>
      <Field label="手机号"><input name="phoneNumber" type="tel" inputMode="tel" autoComplete="tel" required maxLength={14} pattern="(\+86)?1[3-9][0-9]{9}" title="请输入 11 位大陆手机号，可带 +86 前缀" placeholder="请输入 11 位手机号" disabled={busy}/></Field>
      <label className="checkbox privacy-choice"><input name="contactConsent" type="checkbox" required disabled={busy}/><span>我同意将姓名和手机号仅用于本次活动联系与签到，由所属社群管理员查看。取消预约即删除；活动结束 30 天后清除，也可在隐私设置中提前清除。<Link href="/privacy" target="_blank">查看说明</Link></span></label>
      {error&&<p className="registration-error" role="alert">{error}</p>}
      <div className="form-footer"><button type="button" className="secondary" disabled={busy} onClick={()=>setModal('')}>暂不预约</button><button className="primary" disabled={busy}>{busy?'提交中…':'确认预约'}<ArrowUpRight size={17}/></button></div>
    </form>
  </Modal>;
}

function GrantForm({ctx}:{ctx:Item & {communities:Item[]}}){
 const {token,setToken,setModal,communities,run,setToast,busy}=ctx;
return <Modal title="连接你的 Agent" onClose={()=>{setModal('');setToken('');}}>{token?<div className="token-result"><CheckCircle2 size={35}/><h3>授权已创建</h3><p>令牌只显示这一次，请保存在你的 Agent 配置中。</p><code>{token}</code><button className="secondary" onClick={()=>{navigator.clipboard.writeText(token);setToast('令牌已复制');}}><Copy size={16}/>复制令牌</button></div>:<form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(async()=>{const r=await act('grants_create',{name:f.get('name'),days:Number(f.get('days')),scopes:f.getAll('scopes'),communityIds:f.getAll('communityIds')});setToken(r.token);},'授权已创建');}}><Field label="Agent 名称"><input name="name" required placeholder="例如：我的 AI 助手" maxLength={60}/></Field><fieldset><legend>允许的操作</legend>{scopes.map(s=><label className="checkbox" key={s}><input name="scopes" value={s} type="checkbox" defaultChecked={s==='content:read'}/>{scopeLabels[s]}</label>)}</fieldset><fieldset><legend>允许访问的社群</legend><p className="muted">不选择时，只能读取公开内容、发布个人动态。</p>{communities.filter(c=>c.membership_status==='active').map(c=><label className="checkbox" key={c.id}><input name="communityIds" value={c.id} type="checkbox"/>{c.name}</label>)}</fieldset><Field label="有效期"><select name="days"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></Field><button className="primary full" disabled={busy}>创建授权</button></form>}</Modal>;}

function Login({ctx}:{ctx:Item & {communities:Item[]}}){
  const {router,refresh,dev,inviteOnly,setToast}=ctx;
  const [phone,setPhone]=useState(''),[code,setCode]=useState(''),[invitation,setInvitation]=useState(''),[privacyAgreed,setPrivacyAgreed]=useState(false);
  const [sent,setSent]=useState(false),[demoCode,setDemoCode]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState('');
  const fullPhone=phone.trim().startsWith('+86')?phone.trim():`+86${phone.trim()}`;
  const headers={'Content-Type':'application/json','X-Invite-Code':invitation.trim(),'X-Privacy-Version':privacyAgreed?PRIVACY_VERSION:''};
  async function send(){
    setError('');
    if(!privacyAgreed){setError('请先阅读并确认个人信息处理说明。');return;}
    if(!/^\+861[3-9]\d{9}$/.test(fullPhone)){setError('请输入有效的 11 位中国大陆手机号。');return;}
    setSending(true);setDemoCode('');
    try{
      const r=await fetch('/api/auth/phone-number/send-otp',{method:'POST',headers,body:JSON.stringify({phoneNumber:fullPhone})});const d=await r.json();
      if(!r.ok)throw new Error(d.message||'发送失败，请稍后重试');
      setSent(true);
      if(dev){const otp=await api(`dev-otp?phone=${encodeURIComponent(fullPhone)}`);setDemoCode(otp.code||'');}
      setToast(dev?'本地验证码已生成':'验证码已发送');
    }catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  async function verify(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setError('');setSending(true);
    try{
      const r=await fetch('/api/auth/phone-number/verify',{method:'POST',headers,body:JSON.stringify({phoneNumber:fullPhone,code})});const d=await r.json();
      if(!r.ok)throw new Error(d.message||'验证失败，请检查验证码和邀请码');
      refresh();const q=location.search.slice(1);
      if(new URLSearchParams(q).has('client_id'))location.href=`/api/auth/oauth2/authorize?${q}`;else {const target=new URLSearchParams(q).get('returnTo');router.push(target==='/privacy-settings'?target:'/');}
    }catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  return <div className="login-card"><span className="large-mark">AI<span>+</span></span><h1>一起，探索 AI 的可能</h1><p>{inviteOnly?'邀请内测中，和同城伙伴一起实践。':'分享实践，连接同城伙伴。'}</p><form onSubmit={verify}>
    <Field label="手机号"><div className="phone-input"><span>+86</span><input aria-label="手机号" value={phone} onChange={e=>{setPhone(e.target.value);setCode('');setDemoCode('');setSent(false);setError('');}} placeholder="请输入手机号码" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={14} required disabled={sending}/></div></Field>
    {inviteOnly&&<Field label="邀请码（新成员必填）"><input aria-label="邀请码" value={invitation} onChange={e=>{setInvitation(e.target.value);setError('');}} placeholder="粘贴邀请人发给你的邀请码" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={128} disabled={sending}/><small className="muted">已有账户可留空，直接获取验证码登录。</small></Field>}
    <label className="checkbox privacy-choice"><input type="checkbox" checked={privacyAgreed} onChange={e=>setPrivacyAgreed(e.target.checked)} required disabled={sending}/><span>我已阅读<Link href="/privacy" target="_blank">个人信息处理说明</Link>，同意使用手机号完成登录验证。公开资料、活动预约和图片 AI 处理分别按所选功能处理。</span></label>
    <Field label="验证码"><div className="code-input"><input aria-label="验证码" value={code} onChange={e=>setCode(e.target.value)} placeholder="6 位验证码" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={sending}/><button type="button" onClick={send} disabled={sending||!phone||!privacyAgreed}>{sent?'重新获取':'获取验证码'}</button></div></Field>
    {demoCode&&<div className="dev-code">本地体验验证码：<strong>{demoCode}</strong><button type="button" onClick={()=>setCode(demoCode)}>填入</button></div>}
    {error&&<p className="composer-error" role="alert">{error}</p>}
    <button className="primary full" disabled={sending}>{sending?'验证处理中…':'登录 / 注册'}<ArrowUpRight size={18}/></button><p className="login-note">{inviteOnly?'新成员验证通过后创建账户并使用邀请码。':'首次登录将自动创建账户。'}手机号不会公开显示。</p>
  </form></div>;
}

function Consent({ctx}:{ctx:Item & {communities:Item[]}}){
 const {communities,run,needLogin,busy}=ctx;
const [selected,setSelected]=useState<string[]>([]);const params=new URLSearchParams(typeof window!=='undefined'?location.search:'');const requested=(params.get('scope')||'content:read').split(' ');return <div className="page-panel"><Bot size={38}/><h1>授权 Agent 访问社区</h1><p>应用：{params.get('client_id')}</p>{requested.map(s=><div className="scope-row" key={s}><Check size={16}/>{scopeLabels[s]||s}</div>)}<fieldset><legend>允许访问的社群</legend>{communities.filter(c=>c.membership_status==='active').map(c=><label className="checkbox" key={c.id}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>setSelected(e.target.checked?[...selected,c.id]:selected.filter(x=>x!==c.id))}/>{c.name}</label>)}</fieldset><p className="muted">有效期 30 天，可以在“我的 Agent”中随时撤销。</p><div className="form-footer"><button className="secondary" onClick={()=>run(async()=>{const r=await api('oauth/consent','POST',{accept:false,oauthQuery:location.search.slice(1)});location.href=r.redirect_uri||r.url;})}>拒绝</button><button className="primary" disabled={busy} onClick={()=>{if(needLogin())run(async()=>{const r=await api('oauth/consent','POST',{accept:true,communityIds:selected,oauthQuery:location.search.slice(1)});location.href=r.redirect_uri||r.url;},'授权成功');}}>同意授权</button></div></div>;}
