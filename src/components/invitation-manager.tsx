'use client';

import { useEffect,useState,type FormEvent } from 'react';
import { Copy,Plus,RefreshCw } from 'lucide-react';

type Invitation = {id:string;label:string;codeHint:string;expiresAt:string;createdAt:string;usedAt:string|null;usedByName:string|null;revokedAt:string|null};
type CreatedInvitation = {id:string;code:string;label:string;expiresAt:string};
const formatDate=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
async function request(method='GET',body?:unknown,id?:string) {
  const response=await fetch(`/api/v1/admin/invitations${id?`/${encodeURIComponent(id)}`:''}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'邀请码操作失败，请重试');
  return data;
}

export function InvitationManager({enabled}:{enabled:boolean}) {
  const [items,setItems]=useState<Invitation[]>([]),[created,setCreated]=useState<CreatedInvitation[]>([]);
  const [loading,setLoading]=useState(true),[pending,setPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{let valid=true;request().then(data=>{if(valid)setItems(data.items);}).catch(e=>{if(valid)setError(e.message);}).finally(()=>{if(valid)setLoading(false);});return()=>{valid=false;};},[]);
  async function reload(){
    setLoading(true);
    try{
      const latest:Invitation[]=(await request()).items;setItems(latest);
      const available=new Set(latest.filter(item=>!item.usedAt&&!item.revokedAt&&new Date(item.expiresAt)>new Date()).map(item=>item.id));
      setCreated(old=>old.filter(item=>available.has(item.id)));
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  }
  async function create(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();setPending(true);setError('');setNotice('');
    const fields=new FormData(e.currentTarget);
    try {
      const data=await request('POST',{count:Number(fields.get('count')),days:Number(fields.get('days')),label:fields.get('label')});
      setCreated(old=>[...data.items,...old]);setNotice(`已生成 ${data.items.length} 个邀请码，请及时复制保存。`);
      await reload();
    } catch(e){setError((e as Error).message);}finally{setPending(false);}
  }
  async function revoke(id:string) {
    setPending(true);setError('');setNotice('');
    try{await request('DELETE',undefined,id);setCreated(old=>old.filter(item=>item.id!==id));setNotice('邀请码已停用。');await reload();}
    catch(e){setError((e as Error).message);}finally{setPending(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(created.map(item=>item.code).join('\n'));setNotice('邀请码已复制。');}catch{setError('无法自动复制，请选中下方邀请码手动复制。');}}
  return <section className="invitation-manager" aria-labelledby="invitation-title">
    <div className="invitation-heading"><h3 id="invitation-title">内测邀请码</h3><span className="pill">{enabled?'邀请注册已开启':'开放注册中'}</span></div>
    <p className="muted">新成员凭邀请码和手机验证码加入。每码限一人，已有成员直接登录。</p>
    {!enabled&&<p className="composer-error">当前允许无邀请码注册。开启邀请注册后，新成员才需要邀请码。</p>}
    <form onSubmit={create}>
      <div className="form-grid"><label className="field"><span>生成数量</span><input name="count" type="number" min={1} max={20} defaultValue={1} required disabled={pending}/></label><label className="field"><span>有效期（天）</span><input name="days" type="number" min={1} max={30} defaultValue={7} required disabled={pending}/></label></div>
      <label className="field"><span>备注（可选）</span><input name="label" maxLength={120} placeholder="例如：第一批体验成员" disabled={pending}/></label>
      <button className="primary" disabled={pending}><Plus size={17}/>{pending?'处理中…':'生成邀请码'}</button>
    </form>
    {error&&<p className="composer-error" role="alert">{error}</p>}
    {notice&&<p className="muted" role="status">{notice}</p>}
    {created.length>0&&<div className="invitation-result"><strong>请复制保存这 {created.length} 个邀请码</strong><p className="muted">完整邀请码只在本页生成后显示，离开或刷新后无法再次查看。</p><textarea aria-label="本次生成的邀请码" readOnly rows={Math.min(8,created.length+1)} value={created.map(item=>item.code).join('\n')}/><button type="button" className="secondary" onClick={copy}><Copy size={16}/>复制全部邀请码</button></div>}
    <div className="invitation-heading"><h4>发放记录</h4><button className="text-button" disabled={pending||loading} onClick={()=>{setError('');void reload();}}><RefreshCw size={14}/>刷新记录</button></div>
    {loading?<p className="muted">正在读取邀请码…</p>:!items.length?<p className="muted">还没有生成邀请码。</p>:<ul className="invitation-list">{items.map(item=>{
      const status=item.usedAt?'已使用':item.revokedAt?'已停用':new Date(item.expiresAt)<=new Date()?'已过期':'待使用';
      return <li key={item.id}><div><strong>{item.label||'内测邀请'} <code>…{item.codeHint}</code></strong><p>{status}{item.usedAt?` · ${item.usedByName||'成员'} · ${formatDate(item.usedAt)} 领取`:` · ${formatDate(item.expiresAt)} 到期`}</p></div>{status==='待使用'&&<button className="text-button danger" disabled={pending} onClick={()=>revoke(item.id)}>停用</button>}</li>;
    })}</ul>}
  </section>;
}
