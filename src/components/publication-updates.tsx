'use client';

import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { CheckCircle2,Clock } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import styles from './publication-updates.module.css';

const names:Record<string,string>={post:'动态',comment:'评论',draft:'资料或活动',media:'图片描述',link:'链接预览'};
const statusNames:Record<string,string>={pending:'处理中',review:'待确认',rejected:'未通过'};
const unresolved=new Set(['pending','review','rejected']);
function publicationName(item:Item) { return item.draftKind==='profile'?'个人资料':names[item.targetType]||'内容'; }
function publishedUrl(item:Item) {
  if(item.targetType==='post')return `/posts/${item.targetId}`;
  if(item.postId)return `/posts/${item.postId}`;
  if(item.draftKind==='profile')return `/profile/${item.authorId}`;
  if(item.resultTargetId&&String(item.draftKind).startsWith('community'))return `/communities/${item.resultTargetId}`;
  if(item.resultTargetId&&String(item.draftKind).startsWith('event'))return `/events/${item.resultTargetId}`;
  return '/moderation';
}

// This list uses the author's private moderation endpoint, never the public feed.
// The parent keys it by user ID so previews cannot survive an account switch.
export function PublicationUpdates({revision,submission,onPublished}:{revision:number;submission:string;onPublished:()=>void}) {
  const [items,setItems]=useState<Item[]>([]),[published,setPublished]=useState<Item|null>(null),[error,setError]=useState(false);
  const previous=useRef(new Map<string,string>()),registered=useRef('');
  useEffect(()=>{
    if(submission&&submission!==registered.current){
      registered.current=submission;previous.current.set(submission,'pending');setPublished(null);
    }
    let live=true,timer:ReturnType<typeof setTimeout>|undefined,controller:AbortController|null=null;
    async function load() {
      if(!live||document.hidden||controller)return;
      if(timer)clearTimeout(timer);
      const current=new AbortController();controller=current;
      let delay=20000,keepPolling=true;
      try {
        const response=await fetch('/api/v1/moderation?mine=true',{signal:current.signal,cache:'no-store'});
        if(response.status===401||response.status===403){
          if(live&&!current.signal.aborted){setItems([]);setPublished(null);previous.current.clear();setError(false);keepPolling=false;}
          return;
        }
        if(!response.ok)throw new Error('无法读取发布状态');
        const result=await response.json();
        if(!live||current.signal.aborted)return;
        const next:Item[]=result.items;
        const approved=next.filter(item=>item.status==='approved'&&previous.current.has(item.id)&&previous.current.get(item.id)!=='approved');
        for(const item of next)previous.current.set(item.id,item.status);
        // Keep only the latest bounded response; no private drafts in local storage.
        previous.current=new Map(next.map(item=>[item.id,item.status]));
        setItems(next);setError(false);
        if(approved.length){
          const main=approved.find(item=>!['media','link'].includes(item.targetType));
          if(main)setPublished(main);
          onPublished();
        }
        keepPolling=next.some(item=>unresolved.has(item.status));
        if(next.some(item=>item.status==='pending'))delay=4000;
      } catch {
        if(live&&!current.signal.aborted)setError(true);
      } finally {
        if(controller===current)controller=null;
        if(live&&!current.signal.aborted&&keepPolling&&!document.hidden)timer=setTimeout(load,delay);
      }
    }
    function visibilityChanged(){
      if(document.hidden){if(timer)clearTimeout(timer);controller?.abort();controller=null;}
      else void load();
    }
    void load();document.addEventListener('visibilitychange',visibilityChanged);
    return()=>{live=false;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibilityChanged);};
  },[revision,submission,onPublished]);
  const outstanding=items.filter(item=>unresolved.has(item.status)&&!['media','link'].includes(item.targetType));
  const progress=outstanding.length===1?`${publicationName(outstanding[0])}${statusNames[outstanding[0].status]}`:Object.entries(statusNames).map(([status,label])=>{
    const count=outstanding.filter(item=>item.status===status).length;
    return count?`${count} 项${label}`:'';
  }).filter(Boolean).join(' · ');
  if(!outstanding.length&&!published&&!error)return null;
  return <aside className={styles.updates} aria-label="我的发布进度">
    {published&&<div className={styles.row} role="status"><CheckCircle2 size={16} aria-hidden="true"/><span>{publicationName(published)}{published.draftKind==='profile'?'已更新':'已发布'}</span><Link href={publishedUrl(published)}>查看</Link><button type="button" onClick={()=>setPublished(null)}>收起</button></div>}
    {!!outstanding.length&&<div className={styles.row} role="status"><Clock size={16} aria-hidden="true"/><span>{progress}</span><Link href="/moderation">我的发布</Link></div>}
    {error&&<div className={styles.row} role="status"><span>暂时无法更新发布状态，正在重试。</span><Link href="/moderation">查看记录</Link></div>}
  </aside>;
}
