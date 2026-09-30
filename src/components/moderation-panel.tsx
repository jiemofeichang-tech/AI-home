'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { ShieldCheck,RefreshCw,Eye } from 'lucide-react';
import type { Item } from '../shared/contracts';

const statusNames:Record<string,string>={pending:'等待自动审核',review:'等待人工复核',rejected:'已自动隔离',approved:'审核通过',deleted:'已删除'};
const typeNames:Record<string,string>={post:'动态',comment:'评论',draft:'资料 / 社群 / 活动修改'};
function riskNames(labels:string[]=[]) {
  return [...new Set(labels.filter(label=>!['nonLabel','legacy'].includes(label)).map(label=>/political|politic|sensitive|religion/i.test(label)?'政治等敏感语境，需人工判断':/porn|sexual/i.test(label)?'色情或性内容风险':/violent|horrific|blood|terror/i.test(label)?'暴力或血腥风险':label==='provider_unavailable'?'审核服务不可用':'其他疑似风险，需人工判断'))].join('、');
}
async function request(path:string,body?:unknown) {
  const response=await fetch(`/api/v1/${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');return data;
}

export function ModerationPanel({admin=false}:{admin?:boolean}) {
  const [items,setItems]=useState<Item[]>([]),[provider,setProvider]=useState<Item>({}),[status,setStatus]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[version,setVersion]=useState(0);
  useEffect(()=>{
    let live=true;setLoading(true);setError('');
    request(`moderation?mine=${!admin}${status?`&status=${status}`:''}`).then(result=>{if(live){setItems(result.items);setProvider(result.provider||{});}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[admin,status,version]);
  const refresh=()=>setVersion(n=>n+1);
  return <section className="moderation-panel" aria-labelledby={admin?'moderation-admin-title':'moderation-mine-title'}>
    <div className="moderation-heading"><div><h2 id={admin?'moderation-admin-title':'moderation-mine-title'}><ShieldCheck size={23}/>{admin?'内容审核':'我的审核记录'}</h2><p className="muted">{admin?'审核通过后才展示。高风险内容自动隔离，疑似违规内容交由人工复核。':'提交成功后先审核，通过后公开。资料修改通过前，其他人仍看到原版本。'}</p></div><button type="button" className="icon-btn" aria-label="刷新审核记录" onClick={refresh} disabled={loading}><RefreshCw size={18}/></button></div>
    {admin&&!loading&&!error&&<div className={`moderation-service ${provider.configured?'ready':''}`} role="status"><strong>{provider.configured?'自动审核服务已配置':'当前使用人工审核'}</strong><p>{provider.configured?'自动审核结果仅作为处置依据；政治相关、服务异常和无法判定的内容进入人工队列。':'尚未配置可用的云审核服务。新内容保持待审，由管理员人工审核后展示。'}</p></div>}
    <p className="moderation-policy">色情、血腥暴力等高风险内容不直接展示；政治相关内容需结合新闻、知识或讨论语境复核。机器隔离结果可申诉。<Link href="/privacy">查看处理说明</Link></p>
    <label className="moderation-filter">审核状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">全部状态</option>{Object.entries(statusNames).map(([key,name])=><option value={key} key={key}>{name}</option>)}</select></label>
    {error&&<div className="composer-error" role="alert">{error}</div>}{message&&<p role="status" className="moderation-message">{message}</p>}
    {loading?<p className="muted">正在读取审核记录…</p>:items.length?items.map(item=><ModerationItem key={item.id} item={item} admin={admin} onChange={text=>{setMessage(text);refresh();}}/>):!error&&<p className="moderation-empty">暂无符合条件的审核记录。</p>}
    <p className="muted moderation-footnote">展示最近的审核记录。历史内容尚未自动回溯检测；管理员确认删除的内容不会因重试或申诉自动恢复。</p>
  </section>;
}

function ModerationItem({item,admin,onChange}:{item:Item;admin:boolean;onChange:(message:string)=>void}) {
  const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showImages,setShowImages]=useState(false);
  const terminal=item.status==='deleted',canAppeal=!admin&&['review','rejected'].includes(item.status)&&!item.appealReason;
  async function act(action:'approve'|'delete'|'appeal'|'retry'|'withdraw') {
    if(!['retry','withdraw'].includes(action)&&reason.trim().length<2){setError(admin?'请填写审核依据和处理原因。':'请填写申诉理由。');return;}
    if(['delete','withdraw'].includes(action)&&!confirm('确认删除这项内容？删除后不会通过自动重试或申诉恢复。'))return;
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
    {!terminal&&<details className="moderation-preview" open={!admin}><summary>查看提交内容</summary><p className="long-text">{item.text||'图片或引用内容'}</p>{!!item.images?.length&&<><button type="button" className="secondary" onClick={()=>setShowImages(!showImages)}><Eye size={16}/>{showImages?'收起图片':`查看 ${item.images.length} 张图片（可能含敏感内容）`}</button>{showImages&&<div className="moderation-images">{item.images.map((m:Item|string)=>{const id=typeof m==='string'?m:m.id;return <img key={id} src={`/api/v1/moderation/media/${id}`} alt="待审核图片"/>;})}</div>}</>}</details>}
    {item.reason&&<p className="moderation-reason">处理说明：{item.reason}</p>}
    {riskNames(item.labels)&&<p className="moderation-reason">检测提示：{riskNames(item.labels)}</p>}
    {item.appealReason&&<p className="moderation-reason">申诉理由：{item.appealReason}</p>}
    {item.status==='approved'&&item.targetType==='post'&&<Link className="text-button" href={`/posts/${item.targetId}`}>查看已发布动态</Link>}
    {!!item.history?.length&&<details className="moderation-history"><summary>处理记录</summary>{item.history.map((entry:Item,index:number)=><p key={entry.id||index}><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time> · {entry.reason||entry.action}</p>)}</details>}
    {((admin&&!terminal)||canAppeal)&&<div className="moderation-controls"><label className="field"><span>{admin?'处理原因（必填）':'申诉理由（必填）'}</span><textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2} maxLength={1000} placeholder={admin?'结合内容和上下文说明判定依据':'说明内容背景和需要重新核对的地方'} disabled={busy}/></label><div className="filter-row">{admin?<>{item.status!=='approved'&&<button type="button" className="primary" disabled={busy} onClick={()=>act('approve')}>审核通过</button>}<button type="button" className="secondary danger" disabled={busy} onClick={()=>act('delete')}>确认删除</button>{(['review','rejected'].includes(item.status)||(item.status==='approved'&&item.targetType!=='draft'))&&<button type="button" className="text-button" disabled={busy} onClick={()=>act('retry')}>{item.status==='approved'?'发起补审':'重新自动审核'}</button>}</>:<button type="button" className="secondary" disabled={busy} onClick={()=>act('appeal')}>提交申诉</button>}</div></div>}
    {!admin&&['pending','review','rejected'].includes(item.status)&&<button type="button" className="text-button danger" disabled={busy} onClick={()=>act('withdraw')}>撤回这次提交</button>}
    {error&&<p className="composer-error" role="alert">{error}</p>}
  </article>;
}
