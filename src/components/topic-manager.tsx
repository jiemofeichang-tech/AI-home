'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Archive, LayoutGrid, Pencil, Plus } from 'lucide-react';
import { contracts, topicSections, type Item } from '@/shared/contracts';
import { TopicIcon } from './topic-views';
import styles from './topic-manager.module.css';

const blank={slug:'',name:'',description:'',icon:'💬',section:'share',position:100,posting:'members',archived:false};

export function TopicManager({revision,onChanged}:{revision:number;onChanged:()=>void}) {
  const [items,setItems]=useState<Item[]>([]),[editing,setEditing]=useState<Item|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[saving,setSaving]=useState(false);
  const load=useCallback(async()=>{
    const response=await fetch('/api/v1/topics?includeArchived=true',{cache:'no-store'});const data=await response.json();
    if(!response.ok)throw new Error(data.error||'板块加载失败');setItems(data.items);
  },[]);
  useEffect(()=>{load().catch(e=>setError((e as Error).message));},[load,revision]);
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(!editing||saving)return;setError('');setMessage('');
    const parsed=contracts.topics_save.safeParse(editing);
    if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
    setSaving(true);
    try {
      const response=await fetch('/api/v1/actions/topics_save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed.data)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'保存失败');
      setEditing(null);setMessage(`「${data.name}」已保存`);await load();onChanged();
    } catch(e) {setError((e as Error).message);} finally {setSaving(false);}
  }
  const field=(key:string,value:unknown)=>setEditing(current=>current?{...current,[key]:value}:current);
  return <section className={styles.manager}>
    <div className={styles.heading}>
      <h3><LayoutGrid size={18}/>板块管理</h3>
      <button type="button" className="secondary" onClick={()=>{setError('');setMessage('');setEditing({...blank});}}><Plus size={15}/>新建板块</button>
    </div>
    <p className="muted">板块帖子是公开动态。归档后板块从导航隐藏、不再接受新帖，已有帖子保留。</p>
    {message&&<p className={styles.message} role="status">{message}</p>}
    {error&&<p className="composer-error" role="alert">{error}</p>}
    {editing&&<form className={styles.form} onSubmit={save}>
      <div className={styles.row}>
        <label className="field"><span>图标</span><input value={editing.icon} onChange={e=>field('icon',e.target.value)} maxLength={8} required/></label>
        <label className="field"><span>名称</span><input value={editing.name} onChange={e=>field('name',e.target.value)} maxLength={30} required placeholder="例如：AI 视频"/></label>
        <label className="field"><span>标识（网址）</span><input value={editing.slug} onChange={e=>field('slug',e.target.value.toLowerCase())} maxLength={40} required placeholder="ai-video" pattern="[a-z0-9][a-z0-9-]*"/></label>
      </div>
      <label className="field"><span>简介</span><textarea rows={2} value={editing.description} onChange={e=>field('description',e.target.value)} maxLength={500} placeholder="这个板块适合发什么内容？"/></label>
      <div className={styles.row}>
        <label className="field"><span>分组</span><select value={editing.section} onChange={e=>field('section',e.target.value)}>{Object.entries(topicSections).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field"><span>排序（小的在前）</span><input type="number" min={0} max={10000} value={editing.position} onChange={e=>field('position',Number(e.target.value))}/></label>
        <label className="field"><span>谁可以发布</span><select value={editing.posting} onChange={e=>field('posting',e.target.value)}><option value="members">所有成员</option><option value="admins">仅平台管理员</option></select></label>
      </div>
      {editing.id&&<label className="checkbox"><input type="checkbox" checked={!!editing.archived} onChange={e=>field('archived',e.target.checked)}/>归档此板块</label>}
      <div className="form-footer"><button type="button" className="secondary" onClick={()=>setEditing(null)}>取消</button><button className="primary" disabled={saving}>{saving?'保存中…':'保存板块'}</button></div>
    </form>}
    <ul className={styles.list}>{items.map(topic=><li key={topic.id} className={topic.archived_at?styles.archived:''}>
      <TopicIcon topic={topic} size="sm"/>
      <div><strong>{topic.name}</strong><span>/{topic.slug} · {topicSections[topic.section as keyof typeof topicSections]} · {topic.posting==='admins'?'仅管理员发布':'成员可发布'} · {topic.post_count} 条帖子</span></div>
      {topic.archived_at&&<span className="pill"><Archive size={12}/>已归档</span>}
      <button type="button" className="text-button" onClick={()=>{setError('');setMessage('');setEditing({id:topic.id,slug:topic.slug,name:topic.name,description:topic.description,icon:topic.icon,section:topic.section,position:topic.position,posting:topic.posting,archived:!!topic.archived_at});}}><Pencil size={13}/>编辑</button>
    </li>)}</ul>
  </section>;
}
