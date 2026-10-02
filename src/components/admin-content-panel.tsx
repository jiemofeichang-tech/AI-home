'use client';

import { useCallback,useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { RefreshCw,Search } from 'lucide-react';
import styles from './admin-content-panel.module.css';

type TargetType='post'|'comment';
type Status='all'|'visible'|'hidden'|'deleted';
type Decision='hide'|'restore'|'delete';
type ContentItem={id:string;targetType:TargetType;postId?:string;authorId:string;authorName:string;body:string;hiddenAt:string|null;deletedAt:string|null;moderationStatus:string;unavailable:boolean;createdAt:string;communityName?:string;communityVisibility?:string;images?:string[]};
type Page={items:ContentItem[];nextCursor?:string|null};
type Snapshot=Page&{query:string};

async function request(action:'admin_content_list'|'admin_content_moderate',input:unknown,signal?:AbortSignal) {
  const response=await fetch(`/api/v1/actions/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),cache:'no-store',signal});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(data.error||'暂时无法完成操作，请重试。'),{status:response.status});
  return data;
}

function contentStatus(item:ContentItem) {
  if(item.deletedAt)return '已删除';
  if(item.hiddenAt)return '已隐藏';
  if(item.unavailable&&item.moderationStatus==='approved')return '暂不显示';
  return ({approved:'正常显示',pending:'审核中',review:'待人工复核',rejected:'审核未通过',deleted:'已删除'} as Record<string,string>)[item.moderationStatus]||'待确认';
}

export function AdminContentPanel({revision,onChanged}:{revision:number;onChanged:()=>void}) {
  const [targetType,setTargetType]=useState<TargetType>('post'),[status,setStatus]=useState<Status>('all');
  const [search,setSearch]=useState(''),[q,setQ]=useState(''),[version,setVersion]=useState(0);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null),[loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[busyId,setBusyId]=useState('');
  const controller=useRef<AbortController|null>(null),sequence=useRef(0),alive=useRef(true),acting=useRef(false);
  const query=JSON.stringify([targetType,status,q]);
  const visible=snapshot?.query===query?snapshot:null;

  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const load=useCallback(async(cursor?:string)=>{
    controller.current?.abort();
    const current=new AbortController(),requestId=++sequence.current;
    controller.current=current;setError('');
    if(cursor)setLoadingMore(true);else setLoading(true);
    try {
      const result:Page=await request('admin_content_list',{targetType,status,q:q||undefined,limit:20,...(cursor?{cursor}:{})},current.signal);
      if(!alive.current||current.signal.aborted||requestId!==sequence.current)return;
      setSnapshot(previous=>{
        const items=cursor&&previous?.query===query?[...previous.items,...result.items]:result.items;
        return {query,nextCursor:result.nextCursor,items:[...new Map(items.map(item=>[item.id,item])).values()]};
      });
    } catch(failure) {
      if(!alive.current||current.signal.aborted||requestId!==sequence.current)return;
      const problem=failure as Error&{status?:number};
      setError(problem.message);
      if(problem.status===401||problem.status===403)setSnapshot(null);
    } finally {
      if(alive.current&&requestId===sequence.current&&!current.signal.aborted){setLoading(false);setLoadingMore(false);controller.current=null;}
    }
  },[targetType,status,q,query]);
  useEffect(()=>{
    void load();
    return()=>{controller.current?.abort();sequence.current++;};
  },[load,revision,version]);

  async function moderate(item:ContentItem,decision:Decision,reason:string) {
    if(acting.current)return;
    if(decision==='delete'&&!confirm(`确认删除这条${item.targetType==='post'?'帖子':'评论'}？删除后将不再展示，且不能通过“恢复显示”找回。`))return;
    acting.current=true;setBusyId(item.id);setError('');setMessage('');
    try {
      await request('admin_content_moderate',{targetType:item.targetType,targetId:item.id,decision,...(reason.trim()?{reason:reason.trim()}:{})});
      if(!alive.current)return;
      setMessage(decision==='hide'?'已隐藏，可在“隐藏”列表中恢复。':decision==='restore'?'已取消隐藏。内容仍按原审核结果和可见范围展示。':'已删除。');
      setVersion(value=>value+1);onChanged();
    } catch(failure) {
      if(alive.current){
        const problem=failure as Error&{status?:number};setError(problem.message);
        if(problem.status===401||problem.status===403){setSnapshot(null);onChanged();}
      }
    } finally {
      acting.current=false;if(alive.current)setBusyId('');
    }
  }

  const disabled=!!busyId||loading||loadingMore;
  return <section className={styles.panel} aria-labelledby="admin-content-title">
    <div className={styles.heading}><div><h2 id="admin-content-title">全站内容管理</h2><p>平台管理员可直接管理全站帖子和评论。隐藏可恢复；恢复不会跳过内容审核。</p></div><button type="button" className="icon-btn" aria-label="刷新全站内容" disabled={disabled} onClick={()=>setVersion(value=>value+1)}><RefreshCw size={18}/></button></div>
    <div className={styles.filters}>
      <label>内容类型<select value={targetType} disabled={!!busyId} onChange={event=>{setTargetType(event.target.value as TargetType);setMessage('');}}><option value="post">帖子</option><option value="comment">评论</option></select></label>
      <label>显示状态<select value={status} disabled={!!busyId} onChange={event=>{setStatus(event.target.value as Status);setMessage('');}}><option value="all">全部</option><option value="visible">正常显示</option><option value="hidden">隐藏</option><option value="deleted">删除</option></select></label>
    </div>
    <form className={styles.search} onSubmit={event=>{event.preventDefault();setQ(search.trim());setVersion(value=>value+1);setMessage('');}}><input aria-label="搜索全站内容" placeholder="搜索内容或作者" value={search} onChange={event=>setSearch(event.target.value)} maxLength={200} disabled={!!busyId}/><button className="secondary" type="submit" disabled={!!busyId}><Search size={16}/>搜索</button></form>
    {error&&<p className="composer-error" role="alert">{error}{visible&&' 当前保留上次读取的内容。'}</p>}
    {message&&<p className={styles.message} role="status">{message}</p>}
    {loading&&<p className="muted" role="status">{visible?'正在刷新内容…':'正在读取内容…'}</p>}
    {visible?.items.map(item=><AdminContentRow key={`${item.targetType}:${item.id}`} item={item} disabled={disabled} busy={busyId===item.id} onModerate={moderate}/>)}
    {!loading&&!error&&!visible?.items.length&&<p className={styles.empty}>没有符合条件的内容。</p>}
    {visible?.nextCursor&&<button type="button" className={`secondary ${styles.more}`} disabled={disabled} onClick={()=>void load(visible.nextCursor!)}>{loadingMore?'正在加载…':'加载更多'}</button>}
  </section>;
}

function AdminContentRow({item,disabled,busy,onModerate}:{item:ContentItem;disabled:boolean;busy:boolean;onModerate:(item:ContentItem,decision:Decision,reason:string)=>Promise<void>}) {
  const [reason,setReason]=useState(''),[showImages,setShowImages]=useState(false);
  const deleted=!!item.deletedAt||item.moderationStatus==='deleted';
  const visible=!item.unavailable&&!deleted&&!item.hiddenAt&&item.moderationStatus==='approved';
  return <article className={styles.item}>
    <div className={styles.meta}><strong>{item.authorName||'社区成员'}</strong><span className={styles.status}>{contentStatus(item)}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>
    {item.communityName&&<p className={styles.scope}>{item.communityName} · {item.communityVisibility==='private'?'私密社群':'公开社群'}</p>}
    <p className={styles.body}>{item.body||'（无文字内容）'}</p>
    {item.unavailable&&!deleted&&!item.hiddenAt&&item.moderationStatus==='approved'&&<p className={styles.scope}>所属帖子或引用来源暂不可见，此内容暂不展示。</p>}
    {!deleted&&!!item.images?.length&&<div><button type="button" className="text-button" aria-expanded={showImages} onClick={()=>setShowImages(value=>!value)}>{showImages?'收起图片':`查看 ${item.images.length} 张图片`}</button>{showImages&&<div className={styles.images}>{item.images.map(id=><img key={id} src={`/api/v1/moderation/media/${id}`} alt="待管理的帖子图片"/>)}</div>}</div>}
    {visible&&item.communityVisibility!=='private'&&<Link className="text-button" href={`/posts/${item.postId||item.id}`}>{item.targetType==='comment'?'查看所属帖子':'打开帖子'}</Link>}
    {!deleted&&<><details className={styles.reason}><summary>处理说明（选填）</summary><input aria-label="处理说明（选填）" value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000} placeholder="可留空，供后台记录" disabled={disabled}/></details><div className={styles.actions}>{item.hiddenAt?<button className="secondary" type="button" disabled={disabled} onClick={()=>void onModerate(item,'restore',reason)}>恢复显示</button>:<button className="secondary" type="button" disabled={disabled} onClick={()=>void onModerate(item,'hide',reason)}>隐藏{item.targetType==='post'?'帖子':'评论'}</button>}<button className="text-button danger" type="button" disabled={disabled} onClick={()=>void onModerate(item,'delete',reason)}>删除{item.targetType==='post'?'帖子':'评论'}</button>{busy&&<span className="muted" role="status">正在处理…</span>}</div></>}
  </article>;
}
