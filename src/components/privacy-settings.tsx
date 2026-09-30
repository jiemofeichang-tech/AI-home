'use client';

import {useEffect,useState,type FormEvent} from 'react';
import Link from 'next/link';
import {Download,ShieldCheck,Trash2} from 'lucide-react';

type Registration={event_id:string;event_title:string;attendee_name:string|null;phone_number:string|null};
type Account={phoneMask:string;registrations:Registration[];privacyVersion:string|null;acceptedAt:string|null;freshSession:boolean};
async function request(path:string,method='GET',body?:unknown){
  const response=await fetch(`/api/v1/privacy/${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败，请稍后重试');return data;
}
export function PrivacySettings(){
  const [account,setAccount]=useState<Account|null>(null),[loading,setLoading]=useState(true),[pending,setPending]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmation,setConfirmation]=useState('');
  useEffect(()=>{let valid=true;request('account').then(data=>{if(valid)setAccount(data);}).catch(e=>{if(valid)setError(e.message);}).finally(()=>{if(valid)setLoading(false);});return()=>{valid=false;};},[]);
  async function perform(path:string,method:string,body:unknown,message:string){
    setPending(true);setError('');setNotice('');
    try{await request(path,method,body);setAccount(await request('account'));setNotice(message);}catch(e){setError((e as Error).message);}finally{setPending(false);}
  }
  async function download(){
    setPending(true);setError('');setNotice('');
    try{
      const response=await fetch('/api/v1/privacy/export');if(!response.ok)throw new Error((await response.json()).error||'下载失败');
      const url=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=url;anchor.download='my-community-data.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      setNotice('已准备个人数据文件，其中包含你的联系方式，请妥善保存。');
    }catch(e){setError((e as Error).message);}finally{setPending(false);}
  }
  async function close(e:FormEvent<HTMLFormElement>){
    e.preventDefault();setPending(true);setError('');setNotice('');
    try{await request('close','POST',{confirmation});location.assign('/login?closed=1');}
    catch(e){setError((e as Error).message);setPending(false);}
  }
  return <div className="page-content privacy-settings"><div className="section-intro"><ShieldCheck size={30}/><h2>隐私与个人信息</h2><p>查看和管理自己的资料、活动联系人与图片处理授权。</p><Link className="text-button" href="/privacy">阅读个人信息处理说明</Link></div>
    {error&&<p className="composer-error" role="alert">{error}</p>}{notice&&<p className="privacy-notice" role="status">{notice}</p>}
    {loading?<p className="muted">正在读取你的资料…</p>:!account?<Link className="secondary" href="/login?returnTo=%2Fprivacy-settings">登录后管理个人信息</Link>:<>
      <section className="privacy-section"><h3>登录与公开资料</h3><p>登录手机号：{account.phoneMask}</p><p className="muted">手机号不在公开主页显示。昵称、城市和简介公开展示；清空后昵称会替换为随机名称，头像、城市和简介会被清除，仍可正常登录。</p><div className="filter-row"><Link className="secondary" href="/settings">修改公开资料</Link><button className="secondary" disabled={pending} onClick={()=>{if(confirm('清空头像、城市和简介，并将昵称替换为随机名称？'))void perform('clear-profile','POST',{},'公开资料已清空，可返回设置重新填写。');}}>清空公开资料</button></div><p className="muted">{account.acceptedAt?`最近确认个人信息处理说明：${new Date(account.acceptedAt).toLocaleString('zh-CN')}（${account.privacyVersion}）`:'此账号尚无新版个人信息处理说明的确认记录，下次手机验证登录时需确认。'}</p></section>
      <section className="privacy-section"><h3>下载我的数据</h3><p className="muted">下载自己的资料、发布内容、活动报名与授权记录。文件不包含登录令牌、验证码或其他成员的私人联系方式。</p><button className="secondary" disabled={pending} onClick={download}><Download size={16}/>下载个人数据（JSON）</button></section>
      <section className="privacy-section"><h3>活动联系人</h3><p className="muted">姓名和手机号只用于活动联系与签到，所属社群管理员可见。取消预约即删除联系人；活动结束 30 天后自动清除。这里清除联系人会保留报名名额和签到状态。</p>
        {!account.registrations.length?<p className="muted">暂无报名资料。</p>:account.registrations.map(item=><div className="privacy-registration" key={item.event_id}><div><Link href={`/events/${item.event_id}`}>{item.event_title}</Link><p className="muted">{item.attendee_name||item.phone_number?`${item.attendee_name||'未填写姓名'} · ${item.phone_number||'未填写手机号'}`:'联系人已清除或尚未填写'}</p></div>{(item.attendee_name||item.phone_number)&&<button className="text-button danger" disabled={pending} onClick={()=>{if(confirm('清除这次活动保存的姓名和手机号？报名名额会保留。'))void perform('contacts','DELETE',{eventId:item.event_id},'活动联系人已清除，报名名额保留。');}}>清除联系人</button>}</div>)}
        {account.registrations.some(item=>item.phone_number||item.attendee_name)&&<button className="text-button danger" disabled={pending} onClick={()=>{if(confirm('清除所有报名保存的姓名和手机号？报名名额会保留。'))void perform('contacts','DELETE',{},'所有报名联系人已清除。');}}>清除全部活动联系人</button>}
      </section>
      <section className="privacy-section"><h3>图片 AI 处理</h3><p className="muted">每次发图默认不进行 AI 识别。你可以撤回已上传图片的 AI 处理授权，清除站内提取文字与描述，原图和帖子保留。已发送给服务商的图片需通过隐私联系渠道申请处理。</p><button className="secondary" disabled={pending} onClick={()=>{if(confirm('撤回所有图片 AI 处理授权，并清除已提取的文字与描述？'))void perform('withdraw-image-ai','POST',{},'已撤回图片 AI 授权，站内提取结果已清除。');}}>撤回图片 AI 授权</button></section>
      <section className="privacy-section privacy-danger"><h3>注销账号</h3><p>此操作无法撤销。请先下载需要保留的数据。</p><ul><li>清除手机号、昵称、头像、城市、简介，以及本人的帖子内容、评论和活动联系人。</li><li>撤销所有登录会话和 Agent 授权，取消本人报名；本人发起的未结束活动会取消。</li><li>为保留其他成员的关联记录，系统保留无个人资料的账户和内容占位。图片文件进入清理队列，失败会重试；离线备份需由运营方另行清理。</li><li>社群创建者和唯一可用的平台管理员需先完成管理职责交接。</li></ul>
        {!account.freshSession&&<p className="privacy-notice">为确认是你本人，请<Link href="/login?returnTo=%2Fprivacy-settings">重新用手机验证码登录</Link>，再在 10 分钟内完成注销。</p>}
        <details><summary>继续注销</summary><form onSubmit={close}><label className="field"><span>输入“注销我的账号”确认</span><input value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="off" required disabled={pending}/></label><button className="secondary danger" disabled={pending||!account.freshSession||confirmation!=='注销我的账号'}><Trash2 size={16}/>{pending?'处理中…':'确认注销并清除个人资料'}</button></form></details>
      </section>
    </>}
  </div>;
}
