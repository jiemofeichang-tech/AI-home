'use client';

import { useEffect,useRef,useState,type FormEvent } from 'react';
import Link from 'next/link';
import { ImagePlus } from 'lucide-react';
import { Avatar } from './avatar';

type Profile={id:string;name:string;city?:string;bio?:string;image?:string|null;role?:string};
type ProfileInput={name:string;city:string;bio:string;avatarMediaId?:string|null};
type AvatarChoice={id:string|null;url:string|null};

export function ProfileSettings({me,busy,onSave,onLogout}:{me:Profile;busy:boolean;onSave:(input:ProfileInput)=>Promise<unknown>;onLogout:()=>void}) {
  const [name,setName]=useState(me.name),[city,setCity]=useState(me.city||''),[bio,setBio]=useState(me.bio||'');
  const [avatar,setAvatar]=useState<AvatarChoice>(),[uploading,setUploading]=useState(false),[error,setError]=useState(''),[submitted,setSubmitted]=useState(false);
  const uploadRequest=useRef<AbortController|null>(null),fileInput=useRef<HTMLInputElement>(null);
  useEffect(()=>()=>uploadRequest.current?.abort(),[]);
  useEffect(()=>{if(avatar&&submitted&&(me.image||null)===avatar.url)setAvatar(undefined);},[me.image,avatar,submitted]);

  async function upload(file:File|undefined) {
    if(!file)return;
    setError('');
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)){setError('请选择 JPG、PNG、WebP 或 GIF 图片。');return;}
    if(file.size>10*1024*1024){setError('图片不能超过 10 MB，请换一张较小的图片。');return;}
    uploadRequest.current?.abort();const controller=new AbortController();uploadRequest.current=controller;setUploading(true);
    try {
      const form=new FormData();form.set('file',file);
      const response=await fetch('/api/v1/media',{method:'POST',body:form,signal:controller.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'图片上传失败，请重试。');
      if(!controller.signal.aborted){setAvatar({id:result.id,url:result.url});setSubmitted(false);}
    } catch(e){if(!controller.signal.aborted)setError((e as Error).message);}
    finally{if(!controller.signal.aborted)setUploading(false);if(uploadRequest.current===controller)uploadRequest.current=null;}
  }

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(uploading||busy)return;setError('');
    const result=await onSave({name:name.trim(),city,bio,...(avatar?{avatarMediaId:avatar.id}:{})});
    if(result)setSubmitted(true);
  }

  const preview=avatar?avatar.url:me.image;
  return <form className="profile-settings-form" onSubmit={submit}>
    <div className="profile-avatar-editor">
      <Avatar name={name||me.name} image={preview} size="large"/>
      <div className="profile-avatar-controls">
        <strong>头像</strong>
        <div className="profile-avatar-actions">
          <button type="button" className="secondary" disabled={uploading||busy} onClick={()=>fileInput.current?.click()}><ImagePlus size={17}/>{uploading?'上传中…':preview?'更换头像':'上传头像'}</button>
          {preview&&<button type="button" className="text-button" disabled={uploading||busy} onClick={()=>{setAvatar({id:null,url:null});setSubmitted(false);setError('');}}>移除头像</button>}
          {avatar&&!submitted&&<button type="button" className="text-button" disabled={uploading||busy} onClick={()=>{setAvatar(undefined);setError('');}}>取消更换</button>}
        </div>
        <input ref={fileInput} className="avatar-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="选择头像图片" disabled={uploading||busy} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';void upload(file);}}/>
        <p className="muted">支持 JPG、PNG、WebP、GIF，最大 10 MB。</p>
        {avatar&&!submitted&&<p className="avatar-preview-note" role="status">{avatar.url?'新头像预览，保存后提交审核。':'保存后将移除头像。'}</p>}
      </div>
    </div>
    <label className="field"><span>昵称</span><input name="name" value={name} required maxLength={40} disabled={busy} onChange={event=>{setName(event.target.value);setSubmitted(false);}}/></label>
    <label className="field"><span>所在城市</span><input name="city" value={city} maxLength={60} disabled={busy} onChange={event=>{setCity(event.target.value);setSubmitted(false);}}/></label>
    <label className="field"><span>个人介绍</span><textarea name="bio" value={bio} rows={4} maxLength={500} placeholder="你关注什么领域？正在做什么？" disabled={busy} onChange={event=>{setBio(event.target.value);setSubmitted(false);}}/></label>
    <p className="moderation-submit-notice">头像和资料通过审核后公开，期间继续显示原资料。<Link href="/privacy">了解图片与资料处理方式</Link></p>
    {error&&<p className="composer-error" role="alert">{error}</p>}
    {submitted&&<p className="profile-save-notice" role="status">资料已提交。<Link href="/moderation">查看发布状态</Link></p>}
    <button className="primary" disabled={busy||uploading||submitted}>{busy?'正在保存…':submitted?'已提交':'保存资料'}</button>
    <div className="filter-row">{me.role==='admin'&&<Link className="secondary" href="/admin">社区管理</Link>}<button type="button" className="text-button" onClick={onLogout}>退出登录</button></div>
  </form>;
}
