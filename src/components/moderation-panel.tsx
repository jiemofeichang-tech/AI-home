'use client';
import { useEffect,useRef,useState } from 'react';
import Link from 'next/link';
import { ShieldCheck,RefreshCw,Eye } from 'lucide-react';
import type { Item } from '../shared/contracts';

const statusNames:Record<string,string>={pending:'正在自动安全检查',review:'需要管理员人工复核',rejected:'已自动隔离',approved:'已发布',deleted:'已删除'};
const typeNames:Record<string,string>={post:'动态',comment:'评论',draft:'资料 / 社群 / 活动修改',media:'图片文字与描述',link:'链接预览'};
export function moderationRiskNames(labels:string[]=[]) {
  return [...new Set(labels.filter(label=>!['nonLabel','legacy'].includes(label)).map(label=>label==='pt_to_contact'?'疑似引流广告，需人工判断':/political|politic|sensitive|religion/i.test(label)?'政治等敏感语境，需人工判断':/porn|sexual/i.test(label)?'色情或性内容风险':/violent|horrific|blood|terror/i.test(label)?'暴力或血腥风险':label==='provider_unavailable'?'自动审核服务不可用，需人工复核':'其他疑似风险，需人工判断'))].join('、');
}
async function request(path:string,body?:unknown,signal?:AbortSignal) {
  const response=await fetch(`/api/v1/${path}`,{signal,cache:'no-store',method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||'操作失败'),{status:response.status});return data;
}

export function ModerationPanel({admin=false}:{admin?:boolean}) {
  const [items,setItems]=useState<Item[]>([]),[provider,setProvider]=useState<Item>({}),[status,setStatus]=useState(admin?'actionable':''),[loading,setLoading]=useState(true),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[version,setVersion]=useState(0);
  const loadedQuery=useRef('');
  useEffect(()=>{
    const query=`moderation?mine=${!admin}${status?`&status=${status}`:''}`;
    let live=true,controller:AbortController|null=null,timer:ReturnType<typeof setTimeout>|undefined;
    setLoading(loadedQuery.current!==query);setError('');
    async function load() {
      if(!live||document.visibilityState==='hidden'||controller)return;
      if(timer)clearTimeout(timer);
      const current=new AbortController();controller=current;setRefreshing(true);
      let shouldPoll=true,pollDelay=15000;
      try {
        const result=await request(query,undefined,current.signal);
        if(!live||current.signal.aborted)return;
        setItems(result.items);setProvider(result.provider||{});setError('');loadedQuery.current=query;
        const pending=result.items.some((item:Item)=>item.status==='pending');
        shouldPoll=admin||pending||result.items.some((item:Item)=>item.status==='review');
        if(!admin&&pending)pollDelay=5000;
      } catch(e) {
        if(live&&!current.signal.aborted){
          const failure=e as Error&{status?:number};setError(failure.message);
          if(failure.status===401||failure.status===403){
            setItems([]);setProvider({});setMessage('');loadedQuery.current='';shouldPoll=false;
          }
        }
      } finally {
        if(controller===current)controller=null;
        if(live&&!current.signal.aborted){
          setLoading(false);setRefreshing(false);
          if(shouldPoll&&!document.hidden)timer=setTimeout(load,pollDelay);
        }
      }
    }
    function visibilityChanged() {
      if(document.visibilityState==='hidden'){
        if(timer)clearTimeout(timer);
        controller?.abort();controller=null;setRefreshing(false);
      } else void load();
    }
    void load();document.addEventListener('visibilitychange',visibilityChanged);
    return()=>{live=false;if(timer)clearTimeout(timer);controller?.abort();document.removeEventListener('visibilitychange',visibilityChanged);};
  },[admin,status,version]);
  const refresh=()=>setVersion(n=>n+1);
  return <section className="moderation-panel" aria-labelledby={admin?'moderation-admin-title':'moderation-mine-title'}>
    <div className="moderation-heading"><div><h2 id={admin?'moderation-admin-title':'moderation-mine-title'}><ShieldCheck size={23}/>{admin?'内容审核':'我的发布记录'}</h2><p className="muted">{admin?'正常内容自动发布。标为“需要管理员人工复核”的内容已转人工处理，请核对后决定通过或删除。':'正在自动安全检查的内容，通过后按发布范围展示。标为“需要管理员人工复核”的内容，需管理员处理后才能公开；可补充申诉说明或撤回。资料修改通过前，其他人仍看到原版本。'}</p></div><button type="button" className="icon-btn" aria-label="刷新审核记录" onClick={refresh} disabled={refreshing}><RefreshCw size={18}/></button></div>
    {admin&&!loading&&!error&&<div className={`moderation-service ${provider.configured?'ready':''}`} role="status"><strong>{provider.configured?'自动安全检查已启用':'当前使用人工审核'}</strong><p>{provider.configured?'正常内容自动通过，高风险内容自动隔离。暂时的服务故障会自动重试；已转人工复核的记录需要管理员处理。':'尚未配置可用的云审核服务。新内容会转入待处理，需管理员复核后展示。'}</p></div>}
    <p className="moderation-policy">色情、血腥暴力等高风险内容不直接展示；政治相关内容需结合新闻、知识或讨论语境复核。机器隔离结果可申诉。<Link href="/privacy">查看处理说明</Link></p>
    <label className="moderation-filter">{admin?'查看范围':'发布状态'}<select value={status} onChange={e=>setStatus(e.target.value)}>{admin&&<option value="actionable">待处理</option>}<option value="">全部记录</option>{Object.entries(statusNames).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
    {error&&<div className="composer-error" role="alert">{error}</div>}{message&&<p role="status" className="moderation-message">{message}</p>}
    {loading?<p className="muted">正在读取记录…</p>:items.length?items.map(item=><ModerationItem key={item.id} item={item} admin={admin} onChange={text=>{setMessage(text);refresh();}}/>):!error&&<p className="moderation-empty">{admin&&status==='actionable'?'暂时没有需要你处理的内容。正常内容会自动发布，已通过的可在“已发布”中查看。':'暂无符合条件的发布记录。'}</p>}
    <p className="muted moderation-footnote">展示最近的记录。历史内容尚未自动回溯检测；管理员确认删除的内容不会因重试或申诉自动恢复。</p>
  </section>;
}

function ModerationItem({item,admin,onChange}:{item:Item;admin:boolean;onChange:(message:string)=>void}) {
  const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showImages,setShowImages]=useState(false),[previewOpen,setPreviewOpen]=useState(!admin),[historyOpen,setHistoryOpen]=useState(false),[manageOpen,setManageOpen]=useState(false);
  const terminal=item.status==='deleted',derived=['media','link'].includes(item.targetType),needsDecision=['review','rejected'].includes(item.status),canAppeal=!admin&&['review','rejected'].includes(item.status)&&!item.appealReason;
  async function act(action:'approve'|'delete'|'appeal'|'retry'|'withdraw') {
    if(!['retry','withdraw'].includes(action)&&reason.trim().length<2){setError(admin?'请填写审核依据和处理原因。':'请填写申诉理由。');return;}
    if(['delete','withdraw'].includes(action)&&!confirm(derived?'确认移除这份附加内容？动态正文和原图不会删除。':'确认删除这项内容？删除后不会通过自动重试或申诉恢复。'))return;
    setBusy(true);setError('');
    try {
      if(action==='withdraw')await request(`moderation/${item.id}/withdraw`,{});
      else if(action==='appeal')await request(`moderation/${item.id}/appeal`,{reason});
      else if(action==='retry')await request(`admin/moderation/${item.id}/retry`,{});
      else await request(`admin/moderation/${item.id}/decision`,{decision:action,reason});
      setReason('');onChange(action==='approve'?'审核通过，内容已按发布范围展示。':action==='delete'||action==='withdraw'?'内容已撤回或删除。':action==='appeal'?'申诉已提交，等待管理员复核。':'已重新加入审核队列。');
    } catch(e){setError((e as Error).message);} finally{setBusy(false);}
  }
  return <article className="moderation-item">
    <div className="moderation-item-header"><span className={`moderation-status state-${item.status}`}>{item.provider==='legacy'&&item.status==='approved'?'历史记录（未检测）':statusNames[item.status]||item.status}</span><span className="muted">{typeNames[item.targetType]||'内容'}{admin&&item.authorName?` · ${item.authorName}`:''}</span><time>{new Date(item.createdAt).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time></div>
    {!terminal&&<details className="moderation-preview" open={previewOpen} onToggle={event=>setPreviewOpen(event.currentTarget.open)}><summary>查看提交内容</summary><p className="long-text">{item.text||'图片或引用内容'}</p>{!!item.images?.length&&<><button type="button" className="secondary" onClick={()=>setShowImages(!showImages)}><Eye size={16}/>{showImages?'收起图片':`查看 ${item.images.length} 张图片（可能含敏感内容）`}</button>{showImages&&<div className="moderation-images">{item.images.map((m:Item|string)=>{const id=typeof m==='string'?m:m.id;return <img key={id} src={`/api/v1/moderation/media/${id}`} alt="待审核图片"/>;})}</div>}</>}</details>}
    {item.status==='pending'&&<p className="moderation-reason">{derived?'正在自动检查附加内容，动态正文和原图的发布状态不受影响。':admin?'系统正在自动检查，无需手动处理。':'正在自动安全检查，仅自己可见。通过后会按发布范围展示，无需再次提交。'}</p>}
    {item.status==='review'&&<p className="moderation-reason">{admin?'此项已转人工复核。请核对提交内容和检测提示，填写处理原因后选择通过或删除。':`此项已转人工复核，需要管理员确认后才能公开。${item.appealReason?'申诉已提交，由管理员处理。':'可在下方补充申诉说明，或撤回这次提交。'}`}</p>}
    {derived&&item.status!=='pending'&&<p className="moderation-reason">此记录只处理附加内容，不改变动态正文和原图的发布状态。</p>}
    {item.reason&&<p className="moderation-reason">处理说明：{item.reason}</p>}
    {needsDecision&&moderationRiskNames(item.labels)&&<p className="moderation-reason">检测提示：{moderationRiskNames(item.labels)}</p>}
    {item.appealReason&&<p className="moderation-reason">申诉理由：{item.appealReason}</p>}
    {item.status==='approved'&&item.targetType==='post'&&<Link className="text-button" href={`/posts/${item.targetId}`}>查看已发布动态</Link>}
    {!!item.history?.length&&<details className="moderation-history" open={historyOpen} onToggle={event=>setHistoryOpen(event.currentTarget.open)}><summary>处理记录</summary>{item.history.map((entry:Item,index:number)=><p key={entry.id||index}><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time> · {entry.reason||entry.action}</p>)}</details>}
    {admin&&item.status==='approved'&&<button type="button" className="text-button" aria-expanded={manageOpen} onClick={()=>setManageOpen(!manageOpen)}>{manageOpen?'收起管理操作':'管理已发布内容'}</button>}
    {((admin&&!terminal&&(needsDecision||(item.status==='approved'&&manageOpen)))||canAppeal)&&<div className="moderation-controls"><label className="field"><span>{admin?'处理原因（必填）':'申诉理由（必填）'}</span><textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2} maxLength={1000} placeholder={admin?'结合内容和上下文说明判定依据':'说明内容背景和需要重新核对的地方'} disabled={busy}/></label><div className="filter-row">{admin?<>{item.status!=='approved'&&<button type="button" className="primary" disabled={busy} onClick={()=>act('approve')}>审核通过</button>}<button type="button" className="secondary danger" disabled={busy} onClick={()=>act('delete')}>确认删除</button>{(['review','rejected'].includes(item.status)||(item.status==='approved'&&item.targetType!=='draft'))&&<button type="button" className="text-button" disabled={busy} onClick={()=>act('retry')}>{item.status==='approved'?'发起补审':'重新自动审核'}</button>}</>:<button type="button" className="secondary" disabled={busy} onClick={()=>act('appeal')}>提交申诉</button>}</div></div>}
    {!admin&&['pending','review','rejected'].includes(item.status)&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>act('withdraw')}>撤回这次提交</button>}
    {error&&<p className="composer-error" role="alert">{error}</p>}
  </article>;
}
