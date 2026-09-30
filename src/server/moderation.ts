import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, transaction } from './db';
import { active, adminAccess, human, readablePost } from './permissions';
import { fail, type Actor, type Item } from '../shared/contracts';
import { moderateContent, moderationProviderStatus } from './moderation-provider';
import { readModerationDraft, applyModerationDraft } from './moderation-drafts';

type TargetType='post'|'comment'|'draft';
type Status='pending'|'review'|'rejected'|'approved'|'deleted';
type Case={id:string;target_type:TargetType;target_id:string;author_id:string;status:Status;labels:string[];reason:string;appeal_reason:string;provider:string;reviewed_by:string|null;revision:number;generation:number;created_at:Date;updated_at:Date};
type Target={author_id:string;text:string;deleted_at:Date|null;moderation_status:string;images:{id:string;storageKey:string;mime:string}[];post_id?:string;kind?:string;target_id?:string};
const statuses=new Set<Status>(['pending','review','rejected','approved','deleted']);
const unavailableReason='自动审核暂不可用，内容已隔离，请等待人工审核。';

async function queueCase(id:string,client?:PoolClient) {
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'moderation',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),id],client);
}
async function queueIndex(id:string,client:PoolClient) {
  await query(`INSERT INTO jobs(id,kind,target_id) VALUES($1,'index',$2)
    ON CONFLICT(kind,target_id) DO UPDATE SET status='pending',attempts=0,error=NULL,available_at=now(),locked_at=NULL`,[randomUUID(),id],client);
}

export async function enqueueModeration(type:TargetType,targetId:string,authorId:string,client?:PoolClient):Promise<{id:string;revision:number}> {
  if(!client)return transaction(tx=>enqueueModeration(type,targetId,authorId,tx));
  const created=await query(`INSERT INTO moderation_cases(id,target_type,target_id,author_id) VALUES($1,$2,$3,$4) ON CONFLICT(target_type,target_id) DO NOTHING RETURNING id`,[randomUUID(),type,targetId,authorId],client);
  const [entry]=await query<Case>('SELECT * FROM moderation_cases WHERE target_type=$1 AND target_id=$2',[type,targetId],client);
  if(created.length)await history(entry.id,'submit','pending','内容已提交，等待审核。',authorId,client);
  await queueCase(entry.id,client);
  return {id:entry.id,revision:entry.revision};
}

async function authorOpen(authorId:string,client?:PoolClient,lock:'SHARE'|'UPDATE'='SHARE') {
  const [profile]=await query(`SELECT deleted_at FROM profiles WHERE user_id=$1${client?` FOR ${lock}`:''}`,[authorId],client);
  return !!profile&&!profile.deleted_at;
}
async function readTarget(entry:Case,client?:PoolClient):Promise<Target|undefined> {
  if(entry.target_type==='draft')return readModerationDraft(entry.target_id,client);
  const table=entry.target_type==='post'?'posts':'comments';
  const [row]=await query(`SELECT * FROM ${table} WHERE id=$1${client?' FOR UPDATE':''}`,[entry.target_id],client);
  if(!row)return undefined;
  if(entry.target_type==='comment')return {author_id:row.author_id,text:[row.body,row.agent_name||''].join('\n'),deleted_at:row.deleted_at,moderation_status:row.moderation_status,images:[],post_id:row.post_id};
  const media=await query('SELECT id,storage_key,mime,extracted_text,description FROM media WHERE post_id=$1 ORDER BY created_at,id',[row.id],client);
  const links=await query('SELECT url,title,description,content,metadata FROM link_resources WHERE post_id=$1 ORDER BY id',[row.id],client);
  return {author_id:row.author_id,deleted_at:row.deleted_at,moderation_status:row.moderation_status,
    text:[row.body,row.agent_name||'',...links.map(link=>[link.url,link.title,link.description,link.content,JSON.stringify(link.metadata)].join('\n')),...media.map(image=>`${image.extracted_text}\n${image.description}`)].join('\n'),
    images:media.map(image=>({id:image.id,storageKey:image.storage_key,mime:image.mime}))};
}
async function lockedCase(id:string,client:PoolClient) {
  const [hint]=await query<Case>('SELECT * FROM moderation_cases WHERE id=$1',[id],client);
  if(!hint)return undefined;
  if(!await authorOpen(hint.author_id,client,hint.target_type==='draft'?'UPDATE':'SHARE'))return undefined;
  const target=await readTarget(hint,client);
  const [entry]=await query<Case>('SELECT * FROM moderation_cases WHERE id=$1 FOR UPDATE',[id],client);
  if(!target||target.deleted_at||!entry||entry.status==='deleted')return undefined;
  return {entry,target};
}
async function admin(actor:Actor,client?:PoolClient) {
  human(actor);await active(actor,client);
  if(!client){await adminAccess(actor);return;}
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId],client);
  if(profile?.role!=='admin')fail(403,'需要平台管理员权限');
}
async function syncTarget(entry:Case,status:Status,client:PoolClient) {
  if(entry.target_type==='draft'){await applyModerationDraft(entry.target_id,status,client);return;}
  const table=entry.target_type==='post'?'posts':'comments';
  await query(`UPDATE ${table} SET moderation_status=$2,deleted_at=CASE WHEN $2='deleted' THEN coalesce(deleted_at,now()) ELSE deleted_at END WHERE id=$1 AND deleted_at IS NULL`,[entry.target_id,status],client);
  if(entry.target_type==='post') {
    await query('UPDATE media SET moderation_status=$2 WHERE post_id=$1',[entry.target_id,status],client);
    await query('UPDATE link_resources SET moderation_status=$2 WHERE post_id=$1',[entry.target_id,status],client);
    await queueIndex(entry.target_id,client);
  } else if(status==='approved'&&entry.status!=='approved') {
    const [post]=await query(`SELECT p.id,p.author_id FROM posts p JOIN comments c ON c.post_id=p.id
      WHERE c.id=$1 AND p.deleted_at IS NULL AND p.moderation_status='approved'`,[entry.target_id],client);
    if(post&&post.author_id!==entry.author_id)await query("INSERT INTO notifications(id,user_id,text,href) VALUES($1,$2,'你的帖子有一条新回复',$3)",[randomUUID(),post.author_id,`/posts/${post.id}`],client);
  }
}
async function recordAudit(actor:Actor,action:string,id:string,client:PoolClient) {
  await query('INSERT INTO audit_logs(id,user_id,action,target_id) VALUES($1,$2,$3,$4)',[randomUUID(),actor.userId,action,id],client);
}
async function history(id:string,action:string,status:Status,reason:string,actorId:string|null,client:PoolClient) {
  await query('INSERT INTO moderation_history(id,case_id,actor_id,action,status,reason) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,actorId,action,status,reason],client);
}

export async function moderationList(actor:Actor,input:{mine?:boolean;status?:string}) {
  human(actor);await active(actor);
  if(!input.mine)await admin(actor);
  if(input.status&&!statuses.has(input.status as Status))fail(400,'无效的审核状态');
  const entries=await query<Case>(`SELECT c.* FROM moderation_cases c JOIN profiles p ON p.user_id=c.author_id
    WHERE p.deleted_at IS NULL AND ($1::text IS NULL OR c.author_id=$1) AND ($2='' OR c.status=$2)
    ORDER BY c.updated_at DESC,c.id DESC LIMIT 100`,[input.mine?actor.userId:null,input.status||'']);
  const items=[];
  for(const entry of entries) {
    const target=await readTarget(entry);
    const [author]=await query('SELECT name FROM "user" WHERE id=$1',[entry.author_id]);
    const removed=!target||!!target.deleted_at||entry.status==='deleted';
    const events=await query(`SELECT h.id,h.action,h.status,h.reason,h.created_at AS "createdAt",u.name AS "actorName"
      FROM moderation_history h LEFT JOIN "user" u ON u.id=h.actor_id WHERE h.case_id=$1 ORDER BY h.created_at DESC,h.id DESC LIMIT 30`,[entry.id]);
    items.push({id:entry.id,targetType:entry.target_type,targetId:entry.target_id,authorId:entry.author_id,authorName:author?.name||'社区成员',
      text:removed?'':target.text,images:removed?[]:target.images.map(image=>image.id),status:removed?'deleted':entry.status,labels:entry.labels,reason:entry.reason,appealReason:entry.appeal_reason,history:events,
      revision:entry.revision,provider:entry.provider,createdAt:entry.created_at,updatedAt:entry.updated_at,reviewedBy:entry.reviewed_by,
      ...(target?.kind?{draftKind:target.kind,resultTargetId:target.target_id}:{}),...(target?.post_id?{postId:target.post_id}:{})});
  }
  return {items,provider:moderationProviderStatus()};
}

export async function moderationDecide(actor:Actor,input:{id:string;decision:'approve'|'delete';reason:string}) {
  await admin(actor);
  if(!['approve','delete'].includes(input.decision)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)fail(400,'请填写不超过 2000 字的审核理由');
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found)fail(409,'内容已删除、撤回或账户已注销，不能再次放行');
    await admin(actor,client);
    const {entry,target}=found;
    if(entry.target_type==='comment'&&input.decision==='approve')await readablePost({userId:entry.author_id},target.post_id!,client);
    const status=input.decision==='approve'?'approved':'deleted';
    await query(`UPDATE moderation_cases SET status=$2,reason=$3,reviewed_by=$4,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id,status,input.reason.trim(),actor.userId],client);
    await syncTarget(entry,status,client);
    if(status==='approved'&&entry.target_type==='post') {
      await query("UPDATE media SET status='blocked',error='人工审核后停止可选解析' WHERE post_id=$1 AND status IN ('pending','processing')",[entry.target_id],client);
      await query("UPDATE link_resources SET status='partial',error='人工审核后停止链接解析' WHERE post_id=$1 AND status IN ('pending','processing')",[entry.target_id],client);
    }
    await history(entry.id,input.decision,status,input.reason.trim(),actor.userId!,client);
    // Network requests may still be in flight; both their job claim and content
    // revision are invalidated before a manual decision becomes visible.
    await query(`UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE (kind='moderation' AND target_id=$1)
      OR ($2='post' AND ((kind='image' AND target_id IN (SELECT id FROM media WHERE post_id=$3)) OR (kind='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$3))))`,[entry.id,entry.target_type,entry.target_id],client);
    await recordAudit(actor,'moderation_decide',entry.id,client);
    return {ok:true,moderationStatus:status};
  });
}

export async function moderationAppeal(actor:Actor,input:{id:string;reason:string}) {
  human(actor);await active(actor);
  if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)fail(400,'请填写不超过 2000 字的申诉说明');
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found||found.entry.author_id!==actor.userId)fail(404,'审核记录不存在');
    await active(actor,client);
    const {entry}=found;
    if(!['review','rejected'].includes(entry.status))fail(409,'仅可对待人工审核或被隔离的内容提交申诉');
    await query(`UPDATE moderation_cases SET status='review',appeal_reason=$2,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id,input.reason.trim()],client);
    await syncTarget(entry,'review',client);
    await history(entry.id,'appeal','review',input.reason.trim(),actor.userId!,client);
    await query("UPDATE jobs SET status='done',locked_at=NULL WHERE kind='moderation' AND target_id=$1",[entry.id],client);
    await recordAudit(actor,'moderation_appeal',entry.id,client);
    return {ok:true,moderationStatus:'review'};
  });
}

export async function moderationRetry(actor:Actor,input:{id:string}) {
  await admin(actor);
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);if(!found)fail(409,'内容已删除、撤回或账户已注销');
    await admin(actor,client);
    const {entry}=found;
    if(entry.target_type==='draft'&&entry.status==='approved')fail(409,'已发布的修改不能重新应用，请提交新的修改草稿');
    await query(`UPDATE moderation_cases SET status='pending',labels='{}',reason='',provider='',reviewed_by=NULL,revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id],client);
    await syncTarget(entry,'pending',client);await queueCase(entry.id,client);
    await history(entry.id,'retry','pending','管理员重新发起自动审核。',actor.userId!,client);
    await recordAudit(actor,'moderation_retry',entry.id,client);
    return {ok:true,moderationStatus:'pending'};
  });
}

export async function moderationWithdraw(actor:Actor,input:{id:string}) {
  human(actor);await active(actor);
  return transaction(async client=>{
    const found=await lockedCase(input.id,client);
    if(!found||found.entry.author_id!==actor.userId)fail(404,'审核记录不存在');
    await active(actor,client);
    const {entry}=found;
    if(!['pending','review','rejected'].includes(entry.status))fail(409,'只能撤回尚未发布的内容');
    await query(`UPDATE moderation_cases SET status='deleted',reason='作者已撤回此内容。',revision=revision+1,generation=generation+1,updated_at=now() WHERE id=$1`,[entry.id],client);
    await syncTarget(entry,'deleted',client);
    await query("UPDATE jobs SET status='done',error=NULL,locked_at=NULL WHERE kind='moderation' AND target_id=$1",[entry.id],client);
    await history(entry.id,'withdraw','deleted','作者已撤回此内容。',actor.userId!,client);
    await recordAudit(actor,'moderation_withdraw',entry.id,client);
    return {ok:true,moderationStatus:'deleted'};
  });
}

/** Only this special preview route may read unpublished original images. */
export async function moderationMediaAccess(actor:Actor,mediaRow:Item):Promise<boolean> {
  if(!actor.userId||actor.grantId)return false;
  await active(actor);
  if(!await authorOpen(mediaRow.owner_id))return false;
  if(mediaRow.post_id) {
    const [post]=await query('SELECT deleted_at FROM posts WHERE id=$1',[mediaRow.post_id]);
    if(!post||post.deleted_at)return false;
  }
  if(mediaRow.owner_id===actor.userId)return true;
  if(!mediaRow.post_id)return false;
  if(!(await query("SELECT 1 FROM moderation_cases WHERE target_type='post' AND target_id=$1 AND status<>'deleted'",[mediaRow.post_id])).length)return false;
  const [profile]=await query('SELECT role FROM profiles WHERE user_id=$1',[actor.userId]);
  return profile?.role==='admin';
}

/** Capture before starting a network request; manual decisions invalidate it. */
export async function moderationRevisionForPost(postId:string):Promise<number|null> {
  const [entry]=await query(`SELECT c.generation FROM moderation_cases c JOIN posts p ON p.id=c.target_id JOIN profiles u ON u.user_id=p.author_id
    WHERE c.target_type='post' AND p.id=$1 AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND c.reviewed_by IS NULL AND c.status<>'deleted'`,[postId]);
  return entry?.generation??null;
}

/** Write derived content and quarantine its complete post in the same commit. */
export async function saveModeratedDerivation(postId:string,revision:number,write:(client:PoolClient)=>Promise<boolean>):Promise<boolean> {
  return transaction(async client=>{
    const [hint]=await query<Case>("SELECT * FROM moderation_cases WHERE target_type='post' AND target_id=$1",[postId],client);
    if(!hint)return false;
    const found=await lockedCase(hint.id,client);
    if(!found||found.entry.generation!==revision||found.entry.reviewed_by)return false;
    await query("SELECT set_config('app.moderation_write','on',true)",[],client);
    if(!await write(client))return false;
    await query(`UPDATE moderation_cases SET status='pending',labels='{}',reason='',provider='',revision=revision+1,updated_at=now() WHERE id=$1`,[hint.id],client);
    await syncTarget(found.entry,'pending',client);await queueCase(hint.id,client);
    await history(hint.id,'derived_content','pending','图片或链接处理结果已更新，重新审核。',null,client);
    return true;
  });
}

/** Returns false while enrichment is still running, so the job can wait. */
export async function processModeration(id:string):Promise<boolean> {
  const snapshot=await transaction(async client=>{
    const found=await lockedCase(id,client);
    if(!found||found.entry.status!=='pending'||found.entry.reviewed_by)return undefined;
    if(found.entry.target_type==='post') {
      const busy=await query(`SELECT 1 FROM jobs WHERE status IN ('pending','processing') AND
        ((kind='link' AND target_id IN (SELECT id FROM link_resources WHERE post_id=$1)) OR
         (kind='image' AND target_id IN (SELECT id FROM media WHERE post_id=$1 AND ai_consent=true))) LIMIT 1`,[found.entry.target_id],client);
      if(busy.length)return {waiting:true as const};
    }
    return {...found,waiting:false as const};
  });
  if(!snapshot)return true;
  if(snapshot.waiting)return false;
  const {entry,target}=snapshot;
  let status:'approved'|'review'|'rejected'='review',labels:string[]=[],provider='unavailable',reason=unavailableReason;
  try {
    const result=await moderateContent({text:target.text,images:target.images.map(({storageKey,mime})=>({storageKey,mime})),dataId:`${entry.id}:${entry.revision}`});
    if(!['approved','review','rejected'].includes(result.decision))throw new Error('Invalid moderation result');
    status=result.decision;labels=result.labels.filter(label=>typeof label==='string').map(label=>label.slice(0,100)).slice(0,30);provider=result.provider.slice(0,80);
    reason=status==='approved'?'自动审核通过。':status==='rejected'?'自动审核识别到高风险内容，已隔离，可提交申诉。':'内容需要人工审核，审核前不会公开。';
  } catch {labels=['provider_unavailable'];}
  await transaction(async client=>{
    const current=await lockedCase(id,client);
    if(!current||current.entry.revision!==entry.revision||current.entry.status!=='pending'||current.entry.reviewed_by)return;
    if(current.entry.target_type==='comment'&&status==='approved') {
      try {await readablePost({userId:current.entry.author_id},current.target.post_id!,client);}catch {status='review';reason='原帖当前不可访问，请等待人工处理。';}
    }
    await syncTarget(current.entry,status,client);
    await query(`UPDATE moderation_cases SET status=$2,labels=$3,provider=$4,reason=$5,updated_at=now() WHERE id=$1 AND revision=$6`,[id,status,labels,provider,reason,entry.revision],client);
    await history(id,'automatic',status,reason,null,client);
  });
  return true;
}
