'use client';

import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { CheckCircle2,Clock,ShieldCheck } from 'lucide-react';
import type { Item } from '@/shared/contracts';
import { moderationRiskNames } from './moderation-panel';

const names:Record<string,string>={post:'动态',comment:'评论',draft:'资料或活动',media:'图片描述',link:'链接预览'};
const unresolved=new Set(['pending','review','rejected']);
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
  const outstanding=items.filter(item=>unresolved.has(item.status)&&!(item.status==='pending'&&['media','link'].includes(item.targetType)));
  if(!outstanding.length&&!published&&!error)return null;
  return <aside className="publication-updates" aria-label="我的发布进度">
    {published&&<div className="publication-done" role="status"><CheckCircle2 size={17}/><span>{names[published.targetType]||'内容'}已发布</span><Link href={publishedUrl(published)}>查看</Link><button className="text-button" onClick={()=>setPublished(null)}>收起</button></div>}
    {outstanding.slice(0,3).map(item=>{
      const pending=item.status==='pending',review=item.status==='review',risk=moderationRiskNames(item.labels);
      const statusNote=pending?'自动检查通过后按所选范围展示，无需再次提交。':review?`已转人工复核，需要管理员处理后才能公开。${item.appealReason?'申诉已提交。':'可补充申诉说明或撤回。'}`:'可提交申诉，申请管理员人工复核，或撤回这次提交。';
      const scopeNote=['media','link'].includes(item.targetType)?'仅影响附加内容，原动态仍按原状态展示。':item.targetType==='draft'?'原有资料仍正常展示。':'';
      return <div className={`publication-update ${pending?'':'needs-review'}`} key={item.id}>
        <div className="publication-status">{pending?<Clock size={17}/>:<ShieldCheck size={17}/>}<strong>{pending?'正在自动安全检查，仅自己可见':review?'需要管理员人工复核':'内容已隔离，暂未公开'}</strong><span>{names[item.targetType]||'内容'}</span></div>
        <p className="publication-preview">{String(item.text||'图片或引用内容').slice(0,240)}</p>
        {item.reason&&<p className="publication-note">处理说明：{item.reason}</p>}
        {risk&&<p className="publication-note">检测提示：{risk}</p>}
        <div className="publication-note"><span>{statusNote}{scopeNote}</span><Link href="/moderation">{pending?'查看检查进度':review?'查看人工复核记录':'查看说明并申诉'}</Link></div>
      </div>;
    })}
    {outstanding.length>3&&<Link className="text-button" href="/moderation">查看其余 {outstanding.length-3} 条发布记录</Link>}
    {error&&<p className="publication-note" role="status">暂时无法更新发布状态，正在自动重试。<Link href="/moderation">查看记录</Link></p>}
  </aside>;
}
